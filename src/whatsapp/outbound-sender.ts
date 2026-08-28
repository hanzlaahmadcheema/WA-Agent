export interface SendOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  quoted?: any;
}

/**
 * Dispatches an outbound WhatsApp message with exponential backoff retries.
 * Only the message delivery is retried on transient failures, never the command itself.
 */
export async function sendWithRetry(
  sendFn: (jid: string, content: any, options?: any) => Promise<any>,
  jid: string,
  content: { text: string; [key: string]: any },
  options: SendOptions = {}
): Promise<boolean> {
  const maxRetries = options.maxRetries ?? 3;
  let delayMs = options.initialDelayMs ?? 1000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await sendFn(jid, content, { quoted: options.quoted });
      return true;
    } catch (err: any) {
      if (attempt === maxRetries) {
        console.error(
          `[Outbound] Failed to deliver message to ${jid} after ${maxRetries} attempts:`,
          err.message
        );
        return false;
      }

      console.warn(
        `[Outbound] Transient delivery failure (attempt ${attempt}/${maxRetries}) to ${jid}, retrying in ${delayMs}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs *= 2;
    }
  }

  return false;
}
