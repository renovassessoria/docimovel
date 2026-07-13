// api/scan-email.js
// Chamada pelo cron Vercel às 08:00 e 15:00 (BRT)
// Pode ser testada manualmente em: https://app.capacheco.adv.br/api/scan-email

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const REMETENTES_DEFAULT = [
  'publicacoes@publicacoesonline.com.br',
  'oabba@recortedigital.adv.br',
  'pje@tjba.jus.br',
];
const PROC_REGEX = /\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/g;

async function sbGet(table, query = '') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  return r.json();
}

async function sbPost(table, body, prefer = '') {
  return fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: JSON.stringify(body),
  });
}

function detectarTipo(texto = '') {
  const t = texto.toLowerCase();
  if (t.includes('intima')) return 'intimacao';
  if (t.includes('despacho')) return 'despacho';
  if (t.includes('decis')) return 'decisao';
  if (t.includes('cita')) return 'citacao';
  if (t.includes('sentença') || t.includes('sentenca')) return 'decisao';
  if (t.includes('acórdão') || t.includes('acordao')) return 'decisao';
  if (t.includes('publica') || t.includes('dje') || t.includes('diário')) return 'despacho';
  return 'outro';
}

function decodeBase64(str) {
  try {
    const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(base64, 'base64').toString('utf-8');
  } catch {
    return '';
  }
}

function extrairTexto(payload) {
  if (!payload) return '';
  let texto = '';
  if (payload.body?.data) texto += decodeBase64(payload.body.data);
  if (payload.parts) {
    for (const part of payload.parts) {
      texto += extrairTexto(part);
    }
  }
  return texto;
}

function encontrarServico(numProc, servicos) {
  const numClean = numProc.replace(/\D/g, '');
  return (servicos || []).find(s => {
    const n = (
      s.dados_judiciais?.numero ||
      s.dados_judiciais?.numeroProcesso ||
      s.dados_judiciais?.numero_processo || ''
    ).replace(/\D/g, '');
    return n && n.length >= 15 && numClean.length >= 15 &&
      n.slice(-15) === numClean.slice(-15);
  });
}

export default async function handler(req, res) {
  const cronAuth = req.headers['authorization'];
  const isCron = cronAuth === `Bearer ${process.env.CRON_SECRET}`;
  const isGet = req.method === 'GET';
  if (!isCron && !isGet) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // 1. Buscar refresh_token
    const config = await sbGet('configuracoes', '?id=eq.gmail_refresh_token&select=dados');
    const refreshToken = config[0]?.dados?.token;
    if (!refreshToken) return res.status(400).json({ error: 'Gmail não autorizado. Acesse /api/auth/gmail primeiro.' });

    // 1b. Buscar remetentes configurados no banco (ou usar defaults)
    let REMETENTES = [...REMETENTES_DEFAULT];
    try {
      const remConfig = await sbGet('configuracoes', '?id=eq.gmail_remetentes&select=dados');
      const remSalvos = remConfig[0]?.dados?.lista;
      if (Array.isArray(remSalvos) && remSalvos.length > 0) REMETENTES = remSalvos;
    } catch(e) {}

    // 2. Obter access_token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        grant_type: 'refresh_token',
      }),
    });
    const { access_token } = await tokenRes.json();
    if (!access_token) return res.status(500).json({ error: 'Falha ao obter access_token' });

    // 3. Timestamp da última varredura
    const lastScanData = await sbGet('configuracoes', '?id=eq.gmail_last_scan&select=dados');
    const lastScanTs = lastScanData[0]?.dados?.timestamp;
    const afterUnix = lastScanTs
      ? Math.floor(new Date(lastScanTs).getTime() / 1000)
      : Math.floor((Date.now() - 25 * 60 * 60 * 1000) / 1000);

    // 4. Buscar e-mails no Gmail
    const query = `from:(${REMETENTES.join(' OR ')}) after:${afterUnix}`;
    const searchRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=50`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    const searchData = await searchRes.json();
    const messages = searchData.messages || [];

    if (messages.length === 0) {
      await atualizarUltimaVarredura();
      return res.json({ ok: true, message: 'Nenhum e-mail novo encontrado.', processed: 0, created: 0 });
    }

    // 5. IDs já processados (gmail_message_id + numero_processo para evitar duplicatas por processo)
    const existentes = await sbGet('alertas', '?select=gmail_message_id,numero_processo');
    const chaveExistente = new Set(
      (existentes || []).map(a => `${a.gmail_message_id}|${a.numero_processo}`).filter(Boolean)
    );

    // 6. Serviços para cruzamento
    const servicos = await sbGet('servicos', '?select=id,dados_judiciais,cliente_id');

    let created = 0;
    const erros = [];

    // 7. Processar cada mensagem
    for (const msg of messages) {
      try {
        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
          { headers: { Authorization: `Bearer ${access_token}` } }
        );
        const msgData = await msgRes.json();

        const hdrs = msgData.payload?.headers || [];
        const subject = hdrs.find(h => h.name === 'Subject')?.value || '(sem assunto)';
        const from = hdrs.find(h => h.name === 'From')?.value || '';
        const dateStr = hdrs.find(h => h.name === 'Date')?.value || '';

        const corpo = extrairTexto(msgData.payload);
        const textoCompleto = subject + ' ' + corpo + ' ' + (msgData.snippet || '');

        // Extrair TODOS os números de processo únicos do e-mail
        const matches = textoCompleto.match(PROC_REGEX);
        const numerosUnicos = matches ? [...new Set(matches)] : [];

        // Se não encontrou nenhum processo, criar 1 alerta genérico
        if (numerosUnicos.length === 0) {
          const chave = `${msg.id}|null`;
          if (!chaveExistente.has(chave)) {
            const emailRem = from.match(/<(.+)>/)?.[1] || from.trim();
            await sbPost('alertas', {
              tipo: detectarTipo(textoCompleto),
              numero_processo: null,
              assunto: subject.slice(0, 500),
              servico_id: null,
              email_remetente: emailRem,
              email_data: dateStr ? new Date(dateStr).toISOString() : new Date().toISOString(),
              gmail_message_id: msg.id,
              lido: false,
              diligencia_criada: false,
            });
            created++;
          }
          continue;
        }

        const emailRem = from.match(/<(.+)>/)?.[1] || from.trim();
        const emailData = dateStr ? new Date(dateStr).toISOString() : new Date().toISOString();

        // Criar 1 alerta por processo único encontrado no e-mail
        for (const numProc of numerosUnicos) {
          const chave = `${msg.id}|${numProc}`;
          if (chaveExistente.has(chave)) continue; // já processado

          const servico = encontrarServico(numProc, servicos);
          const tipo = detectarTipo(textoCompleto);

          // gmail_message_id único por processo: usar msg.id + sufixo do processo
          const gmailId = numerosUnicos.length === 1
            ? msg.id
            : `${msg.id}_${numProc.replace(/\D/g, '').slice(-10)}`;

          await sbPost('alertas', {
            tipo,
            numero_processo: numProc,
            assunto: subject.slice(0, 500),
            servico_id: servico?.id || null,
            email_remetente: emailRem,
            email_data: emailData,
            gmail_message_id: gmailId,
            lido: false,
            diligencia_criada: false,
          });

          created++;
        }

      } catch (e) {
        erros.push({ id: msg.id, err: e.message });
      }
    }

    await atualizarUltimaVarredura();
    res.json({ ok: true, processed: messages.length, created, erros });

  } catch (err) {
    console.error('[scan-email] Erro:', err);
    res.status(500).json({ error: err.message });
  }

  async function atualizarUltimaVarredura() {
    await sbPost('configuracoes', {
      id: 'gmail_last_scan',
      dados: { timestamp: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    }, 'resolution=merge-duplicates');
  }
}
