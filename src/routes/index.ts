import { Hono } from 'hono'
import { env } from 'hono/adapter'
import { StatusCode } from 'hono/utils/http-status'
import { HTTPException } from 'hono/http-exception'
import { Bindings } from '../types'
import { constantTimeEqual, createAuthCode, mergeNodes, NodeConfig, parseNodeUrls, weightedRandomPick } from '@/utils/helper'
import {
    DEFAULT_HEALTH_CHECK_TIMEOUT,
    DEFAULT_INSTANCE_TTL_SECONDS,
    getDiscoveredInstances,
} from '@/utils/instances'
import { DEFAULT_MAX_RESPONSE_SIZE, proxyFetch, ProxyFetchOptions } from '@/utils/proxy-fetch'
import logger from '@/middlewares/logger'

// 官方实例，默认加入节点池
const DEFAULT_NODE: NodeConfig = { url: 'https://rsshub.app', weight: 1 }

// 冷启动时等待首次实例发现的上限（毫秒）
const COLD_START_MAX_WAIT_MS = 15000

const app = new Hono<{ Bindings: Bindings }>()

app.get('*', async (c) => {
    const {
        RSSHUB_NODE_URLS,
        AUTH_KEY,
        MODE = 'loadbalance',
        AUTO_INSTANCE,
        INSTANCE_TTL,
        HEALTH_CHECK_TIMEOUT,
        INSTANCE_DOC_URL,
    } = env(c)
    const MAX_NODE_NUM = Math.max(parseInt(env(c).MAX_NODE_NUM) || 6, 1) // 最大节点数
    const path = c.req.path
    const query = c.req.query()
    const { authKey, authCode, ...otherQuery } = query
    // 出站请求统一策略：超时中止、响应体上限、重定向校验
    const proxyOptions: ProxyFetchOptions = {
        signal: AbortSignal.timeout(parseInt(env(c).TIMEOUT) || 60000),
        maxBytes: parseInt(env(c).MAX_RESPONSE_SIZE) || DEFAULT_MAX_RESPONSE_SIZE,
        allowedRedirectHosts: (env(c).ALLOW_REDIRECT_HOSTS || '').split(','),
        allowPrivateRedirects: env(c).ALLOW_PRIVATE_REDIRECTS === 'true',
    }
    if (AUTH_KEY) {
        if (!authKey && !authCode) {
            throw new HTTPException(403, { message: 'Auth key or auth code is required' })
        }
        if (authKey && !constantTimeEqual(authKey, AUTH_KEY)) { // 支持通过 authKey 验证
            throw new HTTPException(403, { message: 'Auth key is invalid' })
        }
        const code = createAuthCode(path, AUTH_KEY)
        if (authCode && !constantTimeEqual(authCode, code)) { // 支持通过 authCode 验证
            throw new HTTPException(403, { message: 'Auth code is invalid' })
        }
    }

    // 自动发现公共实例：从官方文档抓取实例列表，健康检查后加入节点池
    // 已有缓存时不阻塞请求； Workers 等运行时中通过 waitUntil 保活刷新任务
    const autoInstance = AUTO_INSTANCE === 'true'
    // 自动发现开启时忽略 RSSHUB_NODE_URLS，节点池完全由发现的健康实例构成，
    // 部署时无需手动填写实例地址
    const parsedNodes = autoInstance ? [] : parseNodeUrls(RSSHUB_NODE_URLS ?? '')
    const discovery = autoInstance
        ? getDiscoveredInstances({
            docUrl: INSTANCE_DOC_URL || undefined,
            ttl: (parseInt(INSTANCE_TTL) || DEFAULT_INSTANCE_TTL_SECONDS) * 1000,
            timeout: parseInt(HEALTH_CHECK_TIMEOUT) || DEFAULT_HEALTH_CHECK_TIMEOUT,
        })
        : { nodes: [] as NodeConfig[], refreshing: undefined }
    if (discovery.refreshing) {
        try {
            c.executionCtx.waitUntil(discovery.refreshing)
        } catch {
            // Node 等运行时没有 executionCtx，后台任务随进程存活，无需处理
        }
        if (!discovery.nodes.length) {
            // 冷启动等待首次发现完成（有上限），避免首个请求落在兜底的官方实例上
            await Promise.race([
                discovery.refreshing.then((nodes) => {
                    discovery.nodes = nodes
                }),
                new Promise<void>((resolve) => setTimeout(resolve, COLD_START_MAX_WAIT_MS)),
            ])
        }
    }
    const discoveredNodes = discovery.nodes

    // 若用户未显式配置默认节点，则自动添加到节点池
    // 自动发现模式下，首次刷新完成前节点池为空，此时保留官方实例作为兜底
    const hasDefaultNode = parsedNodes.some((n) => n.url === DEFAULT_NODE.url)
    // 若发现到健康实例，则以「静态配置 + 健康实例」为节点池，
    // 不再强制加入官方实例（官方实例现已限制访问，是否保留由显式配置决定）
    let allNodes: NodeConfig[]
    if (discoveredNodes.length > 0) {
        allNodes = mergeNodes(parsedNodes, discoveredNodes)
    } else if (hasDefaultNode) {
        allNodes = parsedNodes
    } else {
        allNodes = [DEFAULT_NODE, ...parsedNodes]
    }

    // 将 NodeConfig 转换为带路径和查询参数的完整 URL
    const makeUrl = (node: NodeConfig) => {
        try {
            const _url = new URL(node.url)
            _url.pathname = path
            _url.search = new URLSearchParams(otherQuery).toString()
            return _url.toString()
        } catch (error) {
            logger.error(`Invalid RSSHub node url: ${node.url}`)
            logger.error(error)
            return null
        }
    }

    // 非首页返回 HTML 时视为节点失败，避免代理成为第三方页面的容器
    const isFailedResponse = (contentType: string) => path !== '/' && contentType.includes('text/html')

    // 节点池：按权重抽样，且总数不超过 MAX_NODE_NUM
    const poolNodes = weightedRandomPick(allNodes, Math.min(allNodes.length, MAX_NODE_NUM))

    if (MODE === 'loadbalance') {
        // 负载均衡模式：从所有节点中按权重随机选择一个节点
        const selectedNode = weightedRandomPick(allNodes, 1)[0]
        if (!selectedNode) {
            throw new HTTPException(500, { message: 'No RSSHub nodes available' })
        }
        const nodeUrl = makeUrl(selectedNode)
        if (!nodeUrl) {
            throw new HTTPException(500, { message: 'No valid RSSHub nodes available' })
        }
        const res = await proxyFetch(nodeUrl, proxyOptions)
        if (isFailedResponse(res.contentType)) {
            throw new HTTPException(500, { message: 'RSSHub node is failed' })
        }
        c.header('Content-Type', res.contentType)
        c.status(res.status as StatusCode)
        return c.body(res.body)
    }
    if (MODE === 'failover') {
        // 自动容灾：按权重随机顺序依次尝试节点（不放回）
        const orderedNodes = poolNodes
        for (const node of orderedNodes) {
            const nodeUrl = makeUrl(node)
            if (!nodeUrl) {
                continue
            }
            try {
                const res = await proxyFetch(nodeUrl, proxyOptions)
                // 判断 contentType 类型，除了首页之外，其他页面返回 HTML 的话判断为错误
                if (isFailedResponse(res.contentType)) {
                    throw new HTTPException(500, { message: 'RSSHub node is failed' })
                }
                c.header('Content-Type', res.contentType)
                c.status(res.status as StatusCode)
                return c.body(res.body)
            } catch (error) {
                logger.error(error)
                // 忽略错误，继续请求下一个节点
                continue
            }
        }
        // 所有节点都失败
        throw new HTTPException(500, { message: 'All RSSHub nodes are failed' })
    }

    if (MODE === 'quickresponse') {
        // 快速响应：并发请求节点池中的所有节点，返回最快的成功响应
        const nodeUrls = poolNodes
            .map(makeUrl)
            .filter((url): url is string => Boolean(url))
        if (nodeUrls.length === 0) {
            throw new HTTPException(500, { message: 'No RSSHub nodes available' })
        }
        const res = await Promise.any(nodeUrls.map(async (url) => {
            const resp = await proxyFetch(url, proxyOptions)
            // 判断 contentType 类型，除了首页之外，其他页面返回 HTML 的话判断为错误
            if (isFailedResponse(resp.contentType)) {
                throw new HTTPException(500, { message: 'RSSHub node is failed' })
            }
            return resp
        }))
        c.header('Content-Type', res.contentType)
        c.status(res.status as StatusCode)
        return c.body(res.body)
    }
    // 未指定模式
    throw new HTTPException(500, { message: 'Invalid mode' })
})

export default app
