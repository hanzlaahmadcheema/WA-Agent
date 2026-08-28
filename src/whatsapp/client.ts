import { WhatsAppAdapter } from './adapter.js';

let globalAdapter: WhatsAppAdapter | null = null;

export async function startWhatsAppClient(authDir: string = './auth_info_baileys'): Promise<WhatsAppAdapter> {
  if (globalAdapter) {
    return globalAdapter;
  }

  const adapter = new WhatsAppAdapter({ authDir });
  globalAdapter = adapter;
  await adapter.start();
  return adapter;
}

export async function stopWhatsAppClient(): Promise<void> {
  if (globalAdapter) {
    await globalAdapter.stop();
    globalAdapter = null;
  }
}
