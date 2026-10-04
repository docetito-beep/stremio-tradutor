const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const Parser = require('srt-parser-2').default;
const deepl = require('deepl-node');

const app = express();
const parser = new Parser();

// 1. Configurar cabeçalhos CORS para o Stremio não ser bloqueado
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  next();
});

const translator = process.env.DEEPL_API_KEY 
  ? new deepl.Translator(process.env.DEEPL_API_KEY) 
  : null;

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

// 3. Handler do Stremio para Legendas
builder.defineSubtitlesHandler(async ({ type, id }) => {
  const host = process.env.PUBLIC_URL || 'http://localhost:7000';
  
  return {
    subtitles: [
      {
        id: `ptpt_${id}`,
        url: `${host}/translate.srt?id=${id}`,
        lang: 'por',
        label: '🇵🇹 Português (Traduzido PT-PT)'
      }
    ]
  };
});

// 4. Router oficial do Stremio SDK (Gere automaticamente /manifest.json e /subtitles/...)
const addonInterface = builder.getInterface();
app.use('/', getRouter(addonInterface));

// 5. Endpoint que faz a tradução e serve o ficheiro SRT
app.get('/translate.srt', async (req, res) => {
  const mediaId = req.query.id;
  try {
    const subSearch = await axios.get(`https://sub.wyzie.ru/search?id=${mediaId}`);
    const enSub = subSearch.data?.find(s => s.lang === 'en' || s.lang === 'eng');

    if (!enSub || !enSub.url) {
      return res.status(404).send('Legenda em inglês não encontrada.');
    }

    const srtContent = (await axios.get(enSub.url)).data;
    const parsedSrt = parser.fromSrt(srtContent);

    const textsToTranslate = parsedSrt.map(item => item.text);
    let translatedTexts = [];

    if (translator) {
      const results = await translator.translateText(textsToTranslate, 'en', 'pt-PT');
      translatedTexts = results.map(r => r.text);
    } else {
      translatedTexts = textsToTranslate; 
    }

    const translatedSrtObjects = parsedSrt.map((item, index) => ({
      ...item,
      text: translatedTexts[index] || item.text
    }));

    const finalSrt = parser.toSrt(translatedSrtObjects);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(finalSrt);

  } catch (error) {
    console.error('Erro na tradução:', error.message);
    res.status(500).send('Erro ao processar a tradução da legenda.');
  }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Addon ativo na porta ${PORT}`));
