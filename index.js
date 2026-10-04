const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const Parser = require('srt-parser-2').default;
const deepl = require('deepl-node');

const app = express();
const parser = new Parser();

// 1. Configurar cabeçalhos CORS globais para Stremio Web / Android ExoPlayer
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  next();
});

const translator = process.env.DEEPL_API_KEY 
  ? new deepl.Translator(process.env.DEEPL_API_KEY) 
  : null;

// Configuração do Axios com User-Agent para evitar bloqueios 403
const http = axios.create({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  },
  timeout: 10000
});

// 2. Definição do Manifesto do Stremio
const manifest = {
  id: 'org.comunidade.tradutor.ptpt',
  version: '1.0.0',
  name: 'Tradutor de Legendas (EN -> PT-PT)',
  description: 'Traduz automaticamente legendas de Inglês para Português de Portugal.',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  catalogs: [],
  idPrefixes: ['tt']
};

const builder = new addonBuilder(manifest);

// 3. Subtitles Handler
builder.defineSubtitlesHandler(async ({ type, id }) => {
  const host = process.env.PUBLIC_URL 
    ? process.env.PUBLIC_URL.replace(/\/$/, '') 
    : 'http://localhost:7000';
  
  return {
    subtitles: [
      {
        id: `ptpt_${id}`,
        url: `${host}/translate.srt?id=${encodeURIComponent(id)}`,
        lang: 'por',
        label: '🇵🇹 Português (Traduzido PT-PT)'
      }
    ]
  };
});

// 4. Endpoint do ficheiro SRT
app.get('/translate.srt', async (req, res) => {
  // Configuração rigorosa dos cabeçalhos do player Android
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');

  const fullId = req.query.id;
  if (!fullId) {
    return res.status(200).send('1\n00:00:01,000 --> 00:00:05,000\nID não fornecido.\n\n');
  }

  console.log(`[Legenda] Pedido recebido para ID: ${fullId}`);

  try {
    // Tratar IDs de séries (ex: tt1234567:1:2 -> tt1234567)
    const mediaId = fullId.split(':')[0];

    // A. Procurar legenda na API Wyzie
    const subSearch = await http.get(`https://sub.wyzie.ru/search?id=${mediaId}`);
    const subList = subSearch.data;

    if (!Array.isArray(subList) || subList.length === 0) {
      console.log(`[Legenda] Nenhuma legenda encontrada para: ${mediaId}`);
      return res.status(200).send('1\n00:00:01,000 --> 00:00:05,000\nLegenda em inglês não encontrada.\n\n');
    }

    // Selecionar legenda em inglês
    const enSub = subList.find(s => s.lang === 'en' || s.lang === 'eng') || subList[0];
    const srtDownload = await http.get(enSub.url);
    const rawSrt = srtDownload.data;

    // B. Converter SRT para Objeto
    const parsedSrt = parser.fromSrt(rawSrt);
    if (!parsedSrt || parsedSrt.length === 0) {
      return res.status(200).send(rawSrt); // Entrega o SRT original caso o parse falhe
    }

    const textsToTranslate = parsedSrt.map(item => item.text);
    let translatedTexts = [];

    // C. Tradução via DeepL com Proteção de Erros
    if (translator) {
      try {
        console.log(`[Legenda] Traduzindo ${textsToTranslate.length} linhas com DeepL...`);
        const CHUNK_SIZE = 50;
        
        for (let i = 0; i < textsToTranslate.length; i += CHUNK_SIZE) {
          const chunk = textsToTranslate.slice(i, i + CHUNK_SIZE);
          const results = await translator.translateText(chunk, null, 'pt-PT');
          translatedTexts.push(...results.map(r => r.text));
        }
      } catch (deeplError) {
        console.error('[Legenda] Erro no DeepL (usando texto original):', deeplError.message);
        translatedTexts = textsToTranslate; // Fallback para inglês se o DeepL falhar
      }
    } else {
      translatedTexts = textsToTranslate;
    }

    // D. Reconstruir SRT
    const translatedSrtObjects = parsedSrt.map((item, index) => ({
      ...item,
      text: translatedTexts[index] || item.text
    }));

    const finalSrt = parser.toSrt(translatedSrtObjects);

    console.log(`[Legenda] Legenda entregue com sucesso para: ${fullId}`);
    return res.status(200).send(finalSrt);

  } catch (error) {
    console.error('[Legenda] Erro geral ao processar:', error?.message || error);
    // IMPORTANTE: Devolve HTTP 200 com mensagem explicativa em vez de 500 para não quebrar o Stremio
    return res.status(200).send('1\n00:00:01,000 --> 00:00:05,000\nErro ao traduzir legenda. Verifique o servidor.\n\n');
  }
});

// 5. Instanciar Router do SDK do Stremio
const addonInterface = builder.getInterface();
app.use('/', getRouter(addonInterface));

// 6. Arrancar servidor
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Addon ativo na porta ${PORT}`));
