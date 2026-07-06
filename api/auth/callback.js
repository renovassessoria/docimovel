// api/auth/callback.js
// Google redireciona aqui após autorização. Salva o refresh_token no Supabase.
export default async function handler(req, res) {
  const { code, error } = req.query;

  if (error) return res.status(400).send(`❌ Erro do Google: ${error}`);
  if (!code) return res.status(400).send('❌ Código de autorização não recebido.');

  try {
    // Troca o código pelo refresh_token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });

    const tokens = await tokenRes.json();

    if (!tokens.refresh_token) {
      return res.status(400).send(`❌ refresh_token não recebido. Resposta: ${JSON.stringify(tokens)}`);
    }

    // Salva o refresh_token no Supabase (tabela configuracoes)
    const sbRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/configuracoes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        id: 'gmail_refresh_token',
        dados: { token: tokens.refresh_token },
        updated_at: new Date().toISOString(),
      }),
    });

    if (!sbRes.ok) {
      const err = await sbRes.text();
      return res.status(500).send(`❌ Erro ao salvar no Supabase: ${err}`);
    }

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#1a1c28;color:#d6d3cc">
        <div style="font-size:48px;margin-bottom:16px">✅</div>
        <h2>Gmail autorizado com sucesso!</h2>
        <p style="color:#5a8f6e">O refresh_token foi salvo. A varredura automática está ativa.</p>
        <p style="color:#555;font-size:13px">Você pode fechar esta janela.</p>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send(`❌ Erro interno: ${err.message}`);
  }
}
