import { Injectable } from '@nestjs/common';
import { feishuSendAllowed, feishuWebhookUrl, runtimeTimeoutMs } from '../../common/runtime-config.js';

export type FeishuSendResult = {
  status: 'sent' | 'blocked' | 'failed';
  detail: string;
};

/**
 * Real-first Feishu sender. Posts a text message to a Feishu custom-bot webhook, gated by
 * ALLOW_FEISHU_SEND + FEISHU_WEBHOOK_URL. Never throws: a disabled gate, missing webhook, or
 * transport failure returns a visible blocked/failed result instead.
 */
@Injectable()
export class FeishuNotifierService {
  async send(payload: { title: string; text: string }): Promise<FeishuSendResult> {
    if (!feishuSendAllowed()) {
      return { status: 'blocked', detail: 'ALLOW_FEISHU_SEND 未开启，已跳过真实发送。' };
    }
    const webhook = feishuWebhookUrl();
    if (!webhook) {
      return { status: 'blocked', detail: '未配置 FEISHU_WEBHOOK_URL，无法发送飞书通知。' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), runtimeTimeoutMs());
    try {
      const response = await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msg_type: 'text', content: { text: `${payload.title}\n${payload.text}` } }),
        signal: controller.signal
      });
      if (!response.ok) {
        return { status: 'failed', detail: `飞书 webhook 返回 ${response.status}。` };
      }
      // Feishu replies with { code: 0, msg: 'success' } on success and a non-zero code on error.
      const body = (await response.json().catch(() => ({}))) as { code?: number; msg?: string };
      if (typeof body.code === 'number' && body.code !== 0) {
        return { status: 'failed', detail: `飞书返回错误：${body.code} ${body.msg ?? ''}`.trim() };
      }
      return { status: 'sent', detail: '飞书通知已发送。' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: 'failed', detail: `发送飞书通知失败：${message}` };
    } finally {
      clearTimeout(timer);
    }
  }
}
