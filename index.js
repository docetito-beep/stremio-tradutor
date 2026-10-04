const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const deepl = require('deepl-node');

const app = express();

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

const http = axios.create({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
  },
  timeout: 12000
});

// Funções para processar SRT com compatibilidade total para Android ExoPlayer
function parseSRT(data) {
  if (typeof data !== 'string') data = String(data);
  // Remover caracteres invisíveis (UTF-8 BOM) e normalizar quebras de linha
  data = data.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  
  const regex = /(\d+)\n(\d\d:\d\d:\d\d[,\.]\d\d\d)\s*-->\s*(\d\d:\d\d:\d\d[,\.]\d\d\d)\n([\s\S]*?)(?=\n\n|\n*$)/g;
  const items = [];
  let match;
  
  while ((match = regex.exec(data)) !== null) {
    items.push({
      id: match[1],
      // Forçar o uso de vírgula exigido pelo ExoPlayer Android
      startTime: match[2].replace('.', ','),
      endTime: match[3].replace('.', ','),
      text: match[4].trim()
    });
  }
  return items;
}

function stringifySRT(items) {
  // Formatar com CRLF (\r\n) estrito para o leitor do Stremio
  return items.map(item => {
    return `${item.id}\r\n${item.startTime} --> ${item.endTime}\r\n${item.text}\r\n`;
  }).join('\r\n');
}

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
    const mediaId = fullId.split(':')[0];

    // A. Obter a legenda em inglês
    const subSearch = await http.get(`https://sub.wyzie.ru/search?id=${mediaId}`);
    const subList = subSearch.data;

    if (!Array.isArray(subList) || subList.length === 0) {
      return res.status(200).send("1\r\n00:00:01,000 --> 00:00:05,000\r\nLegenda original não encontrada.\r\n\r\n");
    }

    const enSub = subList.find(s => s.lang === 'en' || s.lang === 'eng') || subList[0];
    const srtDownload = await http.get(enSub.url);
    const rawSrt = srtDownload.data;

    // B. Extração rigorosa dos blocos SRT
    const parsedSrt = parseSRT(rawSrt);
    if (parsedSrt.length === 0) {
      // Se a legenda de origem não tiver padrão standard, envia a original limpa
      return res.status(200).send(rawSrt.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
    }

    const textsToTranslate = parsedSrt.map(item => item.text);
    let translatedTexts = [];

    // C. Tradução via DeepL em blocos de 50 linhas
    if (translator) {
      try {
        console.log(`[Legenda] A traduzir ${textsToTranslate.length} blocos com DeepL...`);
        const CHUNK_SIZE = 50;
        
        for (let i = 0; i < textsToTranslate.length; i += CHUNK_SIZE) {
          const chunk = textsToTranslate.slice(i, i + CHUNK_SIZE);
          const results = await translator.translateText(chunk, null, 'pt-PT');
          translatedTexts.push(...results.map(r => r.text));
        }
      } catch (deeplErr) {
        console.error('[Legenda] Erro no DeepL (usando inglês):', deeplErr.message);
        translatedTexts = textsToTranslate;
      }
    } else {
      translatedTexts = textsToTranslate;
    }

    // D. Reconstrução no formato exato para ExoPlayer
    const finalObjects = parsedSrt.map((item, index) => ({
      ...item,
      text: translatedTexts[index] || item.text
    }));

    const finalSrt = stringifySRT(finalObjects);

    console.log(`[Legenda] Ficheiro SRT enviado com sucesso para: ${fullId}`);
    return res.status(200).send(finalSrt);

  } catch (error) {
    console.error('[Legenda] Erro ao processar:', error?.message || error);
    return res.status(200).send("1\r\n00:00:01,000 --> 00:00:05,000\r\nErro ao traduzir legenda.\r\n\r\n");
  }
});

// 5. Instanciar Router do SDK do Stremio
const addonInterface = builder.getInterface();
app.use('/', getRouter(addonInterface));

// 6. Arrancar servidor
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Addon ativo na porta ${PORT}`));
