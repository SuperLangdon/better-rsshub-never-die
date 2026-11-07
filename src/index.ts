import { serve } from '@hono/node-server'
import { name } from '../package.json'
import { PORT } from './env'
import app from './app'
import logger from './middlewares/logger'
import { DEFAULT_HEALTH_CHECK_TIMEOUT, DEFAULT_INSTANCE_TTL_SECONDS, startInstanceAutoRefresh } from './utils/instances'

serve({
    fetch: app.fetch,
    port: PORT,
})

logger.info(`${name} 启动成功，访问地址：http://localhost:${PORT}`)

// 自动发现公共实例：启动时预热，并按缓存时间定期刷新
if (process.env.AUTO_INSTANCE === 'true') {
    startInstanceAutoRefresh({
        docUrl: process.env.INSTANCE_DOC_URL || undefined,
        ttl: (parseInt(process.env.INSTANCE_TTL ?? '') || DEFAULT_INSTANCE_TTL_SECONDS) * 1000,
        timeout: parseInt(process.env.HEALTH_CHECK_TIMEOUT ?? '') || DEFAULT_HEALTH_CHECK_TIMEOUT,
    })
    logger.info('公共实例自动发现已启用')
}
