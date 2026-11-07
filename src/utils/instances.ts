import { NodeConfig } from '@/utils/helper'
import { proxyFetch } from '@/utils/proxy-fetch'
import logger from '@/middlewares/logger'

/** 公共实例列表页面，默认为官方文档的中文页面 */
export const DEFAULT_INSTANCE_DOC_URL = 'https://docs.rsshub.app/zh/guide/instances'

/** 发现结果的默认缓存时间（秒） */
export const DEFAULT_INSTANCE_TTL_SECONDS = 1800

/** 单个实例健康检查的默认超时（毫秒） */
export const DEFAULT_HEALTH_CHECK_TIMEOUT = 10000

/** 健康检查的并发数上限，避免同时打出过多请求 */
const HEALTH_CHECK_CONCURRENCY = 8

/** 实例列表页面的响应体大小上限（1MB） */
const INSTANCE_LIST_MAX_BYTES = 1024 * 1024

/** 官方实例不从文档中抓取，节点池中的官方实例由静态配置负责 */
const OFFICIAL_INSTANCE_HOST = 'rsshub.app'

/**
 * 文档站对非浏览器 UA 会返回 403，因此抓取时需要伪装浏览器 UA
 */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

export interface DiscoveryOptions {
    /** 公共实例列表页面地址，默认为官方文档 */
    docUrl?: string
    /** 发现结果的缓存时间（毫秒） */
    ttl?: number
    /** 单个实例健康检查的超时（毫秒） */
    timeout?: number
}

/** 已发现的健康实例缓存，模块级共享，在各运行时中随进程/isolate 存活 */
let discoveredCache: {
    nodes: NodeConfig[]
    updatedAt: number
} | undefined

/** 进行中的刷新任务，防止并发重复刷新 */
let refreshTask: Promise<NodeConfig[]> | undefined

/**
 * 规范化实例地址：补全协议、去掉末尾斜杠，并校验合法性
 *
 * @author CaoMeiYouRen
 * @date 2026-11-07
 * @export
 * @param raw 原始地址，形如 `rsshub.example.com` 或 `https://rsshub.example.com/`
 * @returns 规范化后的地址，不合法时返回 null
 */
export function normalizeInstanceUrl(raw: string): string | null {
    let value = raw.trim().replace(/\/+$/, '')
    if (!value) {
        return null
    }
    if (!/^https?:\/\//.test(value)) {
        value = `https://${value}`
    }
    try {
        const url = new URL(value)
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            return null
        }
        if (!url.hostname.includes('.') || url.hostname.endsWith('.')) {
            return null
        }
        return url.toString().replace(/\/+$/, '')
    } catch {
        return null
    }
}

/**
 * 从公共实例文档的 HTML 中解析 Public 章节的实例列表
 *
 * 文档为 VitePress 预渲染页面，Public 表格每行第一个 td 内的 a href 即实例地址。
 * 中英文页面的章节标题均为 `Public`，可以统一定位。
 *
 * @author CaoMeiYouRen
 * @date 2026-11-07
 * @export
 * @param html
 */
export function parsePublicInstances(html: string): string[] {
    const section = html.match(/<h2[^>]*>\s*Public\s*</)?.[0]
    if (!section) {
        return []
    }
    const startIndex = html.indexOf(section)
    const nextHeading = html.slice(startIndex + section.length).search(/<h2\b/)
    const tableHtml = nextHeading === -1
        ? html.slice(startIndex)
        : html.slice(startIndex, startIndex + section.length + nextHeading)

    const seen = new Set<string>()
    const result: string[] = []
    const rows = tableHtml.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) || []
    for (const row of rows) {
        const firstCell = row.match(/<td\b[^>]*>[\s\S]*?<\/td>/)?.[0]
        if (!firstCell) {
            continue
        }
        const href = firstCell.match(/<a\b[^>]*href="(https?:\/\/[^"]+)"/)?.[1]
        if (!href) {
            continue
        }
        const url = normalizeInstanceUrl(href)
        if (!url || seen.has(url)) {
            continue
        }
        try {
            if (new URL(url).hostname === OFFICIAL_INSTANCE_HOST) {
                continue
            }
        } catch {
            continue
        }
        seen.add(url)
        result.push(url)
    }
    return result
}

/**
 * 从公共实例文档抓取实例地址列表
 *
 * @author CaoMeiYouRen
 * @date 2026-11-07
 * @param docUrl
 * @param timeout
 */
async function fetchPublicInstanceUrls(docUrl: string, timeout: number): Promise<string[]> {
    const res = await proxyFetch(docUrl, {
        signal: AbortSignal.timeout(timeout),
        maxBytes: INSTANCE_LIST_MAX_BYTES,
        headers: { 'User-Agent': BROWSER_UA },
    })
    const urls = parsePublicInstances(res.body)
    if (!urls.length) {
        logger.warn(`No public instances parsed from ${docUrl}`)
    }
    return urls
}

/**
 * 检查单个实例的健康状态
 *
 * 以 RSSHub 内置的 `/healthz` 路由为探针，非 2xx 或返回 HTML 均视为不健康。
 *
 * @author CaoMeiYouRen
 * @date 2026-11-07
 * @param instanceUrl
 * @param timeout
 */
export async function checkInstanceHealth(instanceUrl: string, timeout: number): Promise<boolean> {
    try {
        const res = await proxyFetch(`${instanceUrl}/healthz`, {
            signal: AbortSignal.timeout(timeout),
            maxBytes: 64 * 1024,
        })
        return !res.contentType.includes('text/html')
    } catch (error) {
        logger.debug(`Instance ${instanceUrl} health check failed: ${error}`)
        return false
    }
}

/**
 * 并发受限的映射，避免同时打出过多健康检查请求
 *
 * @author CaoMeiYouRen
 * @date 2026-11-07
 * @param items
 * @param limit
 * @param task
 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length)
    let next = 0
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++
            results[index] = await task(items[index])
        }
    })
    await Promise.all(workers)
    return results
}

/**
 * 抓取公共实例列表并逐个健康检查，返回健康的实例
 *
 * @author CaoMeiYouRen
 * @date 2026-11-07
 * @param options
 */
export async function discoverHealthyInstances(options: DiscoveryOptions = {}): Promise<NodeConfig[]> {
    const docUrl = options.docUrl || DEFAULT_INSTANCE_DOC_URL
    const timeout = options.timeout || DEFAULT_HEALTH_CHECK_TIMEOUT
    const urls = await fetchPublicInstanceUrls(docUrl, timeout)
    if (!urls.length) {
        return []
    }
    const healthy = await mapWithConcurrency(urls, HEALTH_CHECK_CONCURRENCY, async (url) => {
        const ok = await checkInstanceHealth(url, timeout)
        if (ok) {
            logger.debug(`Instance ${url} is healthy`)
        }
        return ok
    })
    const nodes = urls.filter((_, i) => healthy[i]).map((url) => ({ url, weight: 1 }))
    logger.info(`Discovered ${nodes.length} healthy instances from ${urls.length} public instances`)
    return nodes
}

/**
 * 刷新缓存中的健康实例
 *
 * 抓取列表失败时保留旧缓存（抓取失败不代表实例不健康）；
 * 健康检查全部失败时写入空结果，由路由回退到静态配置。
 *
 * @author CaoMeiYouRen
 * @date 2026-11-07
 * @param options
 */
async function refreshDiscoveredInstances(options: DiscoveryOptions = {}): Promise<NodeConfig[]> {
    try {
        const nodes = await discoverHealthyInstances(options)
        if (!nodes.length && !discoveredCache) {
            // 从未成功过且本次结果为空，不缓存，避免一次抖动导致整个 TTL 内无可用实例
            return []
        }
        discoveredCache = { nodes, updatedAt: Date.now() }
        return nodes
    } catch (error) {
        logger.error(`Failed to refresh public instances: ${error}`)
        return discoveredCache?.nodes ?? []
    }
}

/**
 * 获取已发现的健康实例，不阻塞请求
 *
 * 缓存未过期时直接返回；过期时后台触发刷新并立即返回旧数据
 * （没有旧数据则返回空数组，由路由回退到静态配置）。
 *
 * @author CaoMeiYouRen
 * @date 2026-11-07
 * @export
 * @param options
 * @returns nodes 为当前可用的健康实例；refreshing 为进行中的刷新任务（若存在），
 *          Workers 等运行时可通过 waitUntil 延长其生命周期
 */
export function getDiscoveredInstances(options: DiscoveryOptions = {}): {
    nodes: NodeConfig[]
    refreshing?: Promise<NodeConfig[]>
} {
    const ttl = options.ttl || DEFAULT_INSTANCE_TTL_SECONDS * 1000
    if (discoveredCache && Date.now() - discoveredCache.updatedAt < ttl) {
        return { nodes: discoveredCache.nodes }
    }
    if (!refreshTask) {
        refreshTask = refreshDiscoveredInstances(options).finally(() => {
            refreshTask = undefined
        })
    }
    return { nodes: discoveredCache?.nodes ?? [], refreshing: refreshTask }
}

/**
 * 启动定时自动刷新（仅 Node.js 等常驻运行时需要调用）
 *
 * @author CaoMeiYouRen
 * @date 2026-11-07
 * @export
 * @param options
 */
export function startInstanceAutoRefresh(options: DiscoveryOptions = {}): void {
    const ttl = options.ttl || DEFAULT_INSTANCE_TTL_SECONDS * 1000
    void refreshDiscoveredInstances(options)
    const timer = setInterval(() => void refreshDiscoveredInstances(options), ttl)
    timer.unref?.()
}
