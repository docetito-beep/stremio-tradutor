const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const Parser = require('srt-parser-2').default;
const deepl = require('deepl-node');

const app = express();
const parser = new Parser();

// Cache em memória
const subtitleCache = new Map();
const MAX_CACHE_SIZE = 100;

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

// Tradução de reserva via Google Translate (Lotes sequenciais seguros)
async function translateWithGoogle(texts) {
  console.log(`[Fallback Google] Traduzindo ${texts.length} linhas em lotes otimizados...`);
  const results = [];
  const CHUNK_SIZE = 40;

  for (let i = 0; i < texts.length; i += CHUNK_SIZE) {
    const chunk = texts.slice(i, i + CHUNK_SIZE);
    
    // Preserva quebras de linha internas convertendo para <br>
    const sanitizedChunk = chunk.map(t => (t || '').replace(/\n/g, ' <br> '));
    const payload = sanitizedChunk.join('\n');

    try {
      const response = await http.get('https://translate.googleapis.com/translate_a/single', {
        params: {
          client: 'gtx',
          sl: 'en',
          tl: 'pt',
          dt: 't',
          q: payload
        },
        timeout: 6000
      });

      if (response.data && response.data[0]) {
        const translatedFull = response.data[0].map(item => item[0]).join('');
        const splitLines = translatedFull.split('\n');

        if (splitLines.length === chunk.length) {
          const restored = splitLines.map(line => 
            line.replace(/<\s*br\s*\/?>/gi, '\n').trim()
          );
          results.push(...restored);
        } else {
          const fallbackBatch = await translateBatchIndividual(chunk);
          results.push(...fallbackBatch);
        }
      } else {
        results.push(...chunk);
      }
    } catch (err) {
      console.error(`[Google Chunk Error]:`, err.message);
      const fallbackBatch = await translateBatchIndividual(chunk);
      results.push(...fallbackBatch);
    }

    // Pausa preventiva de 100ms para evitar bloqueios do Google
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return results;
}

// Auxiliar para traduzir linha a linha caso um lote específico falhe
async function translateBatchIndividual(chunk) {
  const batchResults = [];
  for (const text of chunk) {
    if (!text || !text.trim()) {
      batchResults.push(text);
      continue;
    }
    try {
      const sanitized = text.replace(/\n/g, ' <br> ');
      const response = await http.get('https://translate.googleapis.com/translate_a/single', {
        params: { client: 'gtx', sl: 'en', tl: 'pt', dt: 't', q: sanitized },
        timeout: 3000
      });
      if (response.data && response.data[0]) {
        const full = response.data[0].map(item => item[0]).join('');
        batchResults.push(full.replace(/<\s*br\s*\/?>/gi, '\n').trim());
      } else {
        batchResults.push(text);
      }
    } catch (e) {
      batchResults.push(text);
    }
    await new Promise(r => setTimeout(r, 60));
  }
  return batchResults;
}

const manifest = {
  id: 'org.comunidade.tradutor.ptpt',
  version: '1.4.0',
  name: 'Tradutor de Legendas (EN -> PT-PT)',
  description: 'Traduz automaticamente legendas de Inglês para Português de Portugal.',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  catalogs: [],
  idPrefixes: ['tt']
};

const builder = new addonBuilder(manifest);

builder.defineSubtitlesHandler(async ({ type, id }) => {
  const host = process.env.PUBLIC_URL 
    ? process.env.PUBLIC_URL.replace(/\/$/, '') 
    : 'http://localhost:7000';
  
  return {
    subtitles: [
      {
        id: `ptpt_${id}`,
        url: `${host}/translate.srt?type=${type}&id=${encodeURIComponent(id)}`,
        lang: 'por',
        label: '🇵🇹 Português (Traduzido PT-PT)'
      }
    ]
  };
});

app.get('/translate.srt', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');

  const fullId = req.query.id;
  const type = req.query.type || (fullId && fullId.includes(':') ? 'series' : 'movie');

  if (!fullId) {
    return res.status(200).send("1\r\n00:00:01,000 --> 00:00:05,000\r\nSem ID fornecido.\r\n\r\n");
  }

  if (subtitleCache.has(fullId)) {
    console.log(`[Cache Hit] Legenda entregue para: ${fullId}`);
    return res.status(200).send(subtitleCache.get(fullId));
  }

  console.log(`[Legenda] Pedido de tradução para ID: ${fullId} (${type})`);

  try {
    const subSearch = await http.get(`https://opensubtitles-v3.strem.io/subtitles/${type}/${fullId}.json`);
    const subList = subSearch.data?.subtitles;

    if (!Array.isArray(subList) || subList.length === 0) {
      return res.status(200).send("1\r\n00:00:01,000 --> 00:00:05,000\r\nNenhuma legenda em inglês encontrada.\r\n\r\n");
    }

    const enSub = subList.find(s => s.lang === 'eng' || s.lang === 'en') || subList[0];
    const srtDownload = await http.get(enSub.url);
    let rawSrt = typeof srtDownload.data === 'string' ? srtDownload.data : String(srtDownload.data);

    const parsedSrt = parser.fromSrt(rawSrt);
    if (!parsedSrt || parsedSrt.length === 0) {
      return res.status(200).send(rawSrt.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
    }

    const textsToTranslate = parsedSrt.map(item => item.text);
    let translatedTexts = [];

    if (translator) {
      try {
        console.log(`[DeepL] Traduzindo ${textsToTranslate.length} linhas...`);
        const CHUNK_SIZE = 250;
        for (let i = 0; i < textsToTranslate.length; i += CHUNK_SIZE) {
          const chunk = textsToTranslate.slice(i, i + CHUNK_SIZE);
          const results = await translator.translateText(chunk, null, 'pt-PT');
          translatedTexts.push(...results.map(r => r.text));
        }
      } catch (deeplErr) {
        console.warn('[DeepL Quota/Erro]:', deeplErr.message);
        translatedTexts = await translateWithGoogle(textsToTranslate);
      }
    } else {
      translatedTexts = await translateWithGoogle(textsToTranslate);
    }

    const translatedObjects = parsedSrt.map((item, index) => ({
      ...item,
      text: translatedTexts[index] || item.text
    }));

    let finalSrt = parser.toSrt(translatedObjects);
    finalSrt = finalSrt.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');

    if (subtitleCache.size >= MAX_CACHE_SIZE) {
      const firstKey = subtitleCache.keys().next().value;
      subtitleCache.delete(firstKey);
    }
    subtitleCache.set(fullId, finalSrt);

    console.log(`[Legenda] Concluída com sucesso para: ${fullId}`);
    return res.status(200).send(finalSrt);

  } catch (error) {
    console.error('[Geral Error]:', error?.message || error);
    return res.status(200).send(`1\r\n00:00:01,000 --> 00:00:05,000\r\nErro do servidor: ${error?.message || 'Falha desconhecida'}\r\n\r\n`);
  }
});

const addonInterface = builder.getInterface();
app.use('/', getRouter(addonInterface));

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Addon ativo na porta ${PORT}`));
