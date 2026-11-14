import { createHmac } from 'node:crypto'
import type { HttpRequestConfig } from '../network/HttpClient'
import type { WebhookDingTalkConfig } from '../config/Config'
import type { LogLevel } from './Logger'
import { createNotificationQueue, enqueueNotification, flushQueue } from './Queue'

// DingTalk custom robots accept at most 20 messages per minute.
const dingtalkQueue = createNotificationQueue({ interval: 3000, intervalCap: 1 })

const LOG_LINE_RE = /^\[([^\]]+)\] \[([^\]]*)\] \[(?:DEBUG|INFO|WARN|ERROR)\] (?:MAIN|API) \[([^\]]+)\] ([\s\S]*)$/

function getDingTalkEmoji(level: LogLevel): string {
    switch (level) {
        case 'error':
            return '❌'
        case 'warn':
            return '⚠️'
        case 'info':
            return 'ℹ️'
        case 'debug':
            return '🐛'
        default:
            return '📝'
    }
}

const RUN_STATUS_TEXT: Record<string, string> = {
    completed: '✅ 全部完成',
    partial: '⚠️ 部分完成',
    interrupted: '⛔ 已中断'
}

interface ParsedLogLine {
    ts: string
    user: string
    component: string
    message: string
}

function parseLogLine(content: string): ParsedLogLine | undefined {
    const match = content.match(LOG_LINE_RE)
    if (!match) return undefined
    return {
        ts: match[1] ?? '',
        user: match[2] ?? '',
        component: match[3] ?? '',
        message: (match[4] ?? '').trim()
    }
}

// "key=value" pairs separated by " | " after an optional leading sentence.
function parseKeyValuePairs(message: string): Record<string, string> {
    const pairs: Record<string, string> = {}
    for (const segment of message.split(' | ')) {
        const eq = segment.indexOf('=')
        if (eq > 0) pairs[segment.slice(0, eq).trim()] = segment.slice(eq + 1).trim()
    }
    return pairs
}

// Convert the log's UTC timestamp to the container's local timezone (TZ, default Asia/Shanghai).
function formatLocalTime(ts: string): string {
    const date = new Date(ts)
    if (Number.isNaN(date.getTime())) return ts
    return new Intl.DateTimeFormat('zh-CN', {
        timeZone: process.env.TZ || 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).format(date)
}

function formatRunEnd(message: string, ts: string): string {
    const pairs = parseKeyValuePairs(message)
    const interrupted = message.startsWith('Run interrupted')
    const status = pairs['status'] ?? (interrupted ? 'interrupted' : 'partial')
    const lines = ['📊 Microsoft Rewards 运行报告', `时间：${formatLocalTime(ts)}`, `状态：${RUN_STATUS_TEXT[status] ?? status}`]
    if (pairs['accountsProcessed']) lines.push(`账号数：${pairs['accountsProcessed']}`)
    if (pairs['pointsGained']) lines.push(`本轮积分：+${pairs['pointsGained']}`)
    if (pairs['previousBalance'] && pairs['currentBalance'])
        lines.push(`余额：${pairs['previousBalance']} → ${pairs['currentBalance']}`)
    if (pairs['runtimeMinutes']) lines.push(`耗时：${pairs['runtimeMinutes']} 分钟`)
    return lines.join('\n')
}

function formatAccountEnd(message: string, ts: string): string {
    const emailMatch = message.match(/^Finished account:\s*(\S+)/)
    const pairs = parseKeyValuePairs(message)
    const lines = [`👤 账号完成：${emailMatch?.[1] ?? '未知'}`, `时间：${formatLocalTime(ts)}`]
    const status = pairs['status'] ?? 'unknown'
    if (pairs['pointsGained']) lines.push(`本轮积分：+${pairs['pointsGained']}（${RUN_STATUS_TEXT[status] ?? status}）`)
    if (pairs['currentBalance']) lines.push(`当前余额：${pairs['currentBalance']}`)
    if (pairs['durationSeconds']) lines.push(`用时：${pairs['durationSeconds']} 秒`)
    const activities = message.match(/activities:\s*(.+)$/m)
    if (activities) lines.push(`活动：${(activities[1] ?? '').trim()}`)
    if (pairs['reason'] && pairs['reason'] !== '""')
        lines.push(`未完成原因：${pairs['reason'].replace(/^"|"$/g, '').slice(0, 300)}`)
    return lines.join('\n')
}

function formatDingTalkContent(content: string, level: LogLevel): string {
    const parsed = parseLogLine(content)
    if (!parsed) return `${getDingTalkEmoji(level)}\n${content}`.slice(0, 4000)

    if (parsed.message.startsWith('Completed all accounts') || parsed.message.startsWith('Run interrupted')) {
        return `${getDingTalkEmoji(level)}\n${formatRunEnd(parsed.message, parsed.ts)}`.slice(0, 4000)
    }
    if (parsed.message.startsWith('Finished account:')) {
        return formatAccountEnd(parsed.message, parsed.ts).slice(0, 4000)
    }
    return `${getDingTalkEmoji(level)} [${formatLocalTime(parsed.ts)}] [${parsed.component}] ${parsed.message}`.slice(0, 4000)
}

// https://open.dingtalk.com/document/robots/customize-robot-security-settings
function signUrl(secret: string): string {
    const timestamp = Date.now()
    const stringToSign = `${timestamp}\n${secret}`
    const sign = createHmac('sha256', secret).update(stringToSign).digest('base64')
    return `&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`
}

export async function sendDingTalk(config: WebhookDingTalkConfig, content: string, level: LogLevel): Promise<void> {
    if (!config?.accessToken) return

    const message = formatDingTalkContent(content, level)

    const request: HttpRequestConfig = {
        method: 'POST',
        url: `https://oapi.dingtalk.com/robot/send?access_token=${config.accessToken}${config.secret ? signUrl(config.secret) : ''}`,
        headers: { 'Content-Type': 'application/json' },
        data: {
            msgtype: 'text',
            text: {
                content: message
            },
            at: {
                isAtAll: level === 'error'
            }
        },
        timeout: 10000
    }

    await enqueueNotification(dingtalkQueue, 'DingTalk', content, level, request)
}

export function flushDingTalkQueue(timeoutMs = 5000): Promise<void> {
    return flushQueue(dingtalkQueue, timeoutMs)
}
