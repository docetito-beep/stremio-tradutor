const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const Parser = require('srt-parser-2').default;
const deepl = require('deepl-node');

const app = express();
const parser = new Parser();

// 1. Configurar cabeçalhos CORS globais para Stremio Web / Android Box
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  next();
});

const translator = process.env.DEEPL_API_KEY 
  ? new deepl.Translator(process.env.DEEPL_API_KEY) 
  : null;

const http = axios.create({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
  },
  timeout: 12000
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');

  const fullId = req.query.id;
  if (!fullId) {
    return res.status(200).send("1\r\n00:00:01,000 --> 00:00:05,000\r\nSem ID fornecido.\r\n\r\n");
  }

  console.log(`[Legenda] Pedido recebido para ID: ${fullId}`);

  try {
    const mediaId = fullId.split(':')[0]; // Trata IDs de filmes e séries

    // A. Pesquisa de legenda original
    let subSearch;
    try {
      subSearch = await http.get(`https://sub.wyzie.ru/search?id=${mediaId}`);
    } catch (wyzieErr) {
      console.error('[Wyzie Error]:', wyzieErr.message);
      return res.status(200).send(`1\r\n00:00:01,000 --> 00:00:05,000\r\nErro ao procurar legenda no Wyzie: ${wyzieErr.message}\r\n\r\n`);
    }

    const subList = subSearch.data;
    if (!Array.isArray(subList) || subList.length === 0) {
      return res.status(200).send("1\r\n00:00:01,000 --> 00:00:05,000\r\nNenhuma legenda em inglês encontrada.\r\n\r\n");
    }

    // B. Download do ficheiro SRT
    const enSub = subList.find(s => s.lang === 'en' || s.lang === 'eng') || subList[0];
    const srtDownload = await http.get(enSub.url);
    let rawSrt = srtDownload.data;

    if (typeof rawSrt !== 'string') {
      rawSrt = String(rawSrt);
    }

    // C. Parser do SRT
    const parsedSrt = parser.fromSrt(rawSrt);
    if (!parsedSrt || parsedSrt.length === 0) {
      const cleanRaw = rawSrt.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
      return res.status(200).send(cleanRaw);
    }

    const textsToTranslate = parsedSrt.map(item => item.text);
    let translatedTexts = [];

    // D. Tradução em lotes otimizados de 200 linhas (evita erro 429 do DeepL)
    if (translator) {
      console.log(`[Legenda] Traduzindo ${textsToTranslate.length} linhas com DeepL...`);
      const CHUNK_SIZE = 200;
      
      try {
        for (let i = 0; i < textsToTranslate.length; i += CHUNK_SIZE) {
          const chunk = textsToTranslate.slice(i, i + CHUNK_SIZE);
          const results = await translator.translateText(chunk, null, 'pt-PT');
          translatedTexts.push(...results.map(r => r.text));
        }
      } catch (deeplErr) {
        console.error('[DeepL Error]:', deeplErr.message);
        // Em caso de erro de quota/chave no DeepL, usa o texto original em inglês em vez de falhar
        translatedTexts = textsToTranslate;
      }
    } else {
      translatedTexts = textsToTranslate;
    }

    // E. Reconstrução do SRT no formato exigido pelo Android
    const translatedObjects = parsedSrt.map((item, index) => ({
      ...item,
      text: translatedTexts[index] || item.text
    }));

    let finalSrt = parser.toSrt(translatedObjects);
    finalSrt = finalSrt.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');

    console.log(`[Legenda] Legenda entregue com sucesso para: ${fullId}`);
    return res.status(200).send(finalSrt);

  } catch (error) {
    console.error('[Geral Error]:', error?.message || error);
    return res.status(200).send(`1\r\n00:00:01,000 --> 00:00:05,000\r\nErro do servidor: ${error?.message || 'Falha desconhecida'}\r\n\r\n`);
  }
});

// 5. Router do SDK do Stremio
const addonInterface = builder.getInterface();
app.use('/', getRouter(addonInterface));

// 6. Arrancar servidor
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Addon ativo na porta ${PORT}`));
