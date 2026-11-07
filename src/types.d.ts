export type Bindings = {
    NODE_ENV: string
    PORT: string
    LOGFILES: string
    LOG_LEVEL: string
    TIMEOUT: string
    MAX_BODY_SIZE: string
    // RSSHub 实例地址，AUTO_INSTANCE 为 true 时不生效
    RSSHUB_NODE_URLS?: string
    CACHE_MAX_AGE: string
    AUTH_KEY: string
    // 响应体大小上限（字节），默认 10MB
    MAX_RESPONSE_SIZE: string
    // 允许跨 host 重定向的目标，英文逗号分隔
    ALLOW_REDIRECT_HOSTS: string
    // 是否允许跨 host 重定向到回环/内网地址，true/false
    ALLOW_PRIVATE_REDIRECTS: string
    // 运行模式：负载均衡/自动容灾/快速响应
    MODE: 'loadbalance' | 'failover' | 'quickresponse'
    MAX_NODE_NUM: string
    // 是否自动发现公共实例（从官方文档抓取并健康检查），true/false
    AUTO_INSTANCE: string
    // 发现结果的缓存时间（秒），默认 1800
    INSTANCE_TTL: string
    // 单个实例健康检查的超时时间（毫秒），默认 10000
    HEALTH_CHECK_TIMEOUT: string
    // 公共实例列表页面地址，默认为官方文档
    INSTANCE_DOC_URL: string
}
