const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const Parser = require('srt-parser-2').default;
const deepl = require('deepl-node');

const app = express();
const parser = new Parser();

// 1. Configurar cabeçalhos CORS globais para permitir ligação do Stremio
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  next();
});

// Configurar o tradutor DeepL se a chave de API estiver definida
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

// 3. Handler do Stremio para indicar a presença da legenda traduzida
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

// 4. Endpoint que descarrega, traduz em lotes e serve o ficheiro SRT
app.get('/translate.srt', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');

  const mediaId = req.query.id;
  if (!mediaId) {
    return res.status(400).send('ID do media não fornecido.');
  }

  console.log(`[Legenda] Pedido recebido para ID: ${mediaId}`);

  try {
    // A. Procurar legenda em inglês na API
    const subSearch = await axios.get(`https://sub.wyzie.ru/search?id=${mediaId}`);
    const subList = subSearch.data;

    if (!subList || subList.length === 0) {
      console.log(`[Legenda] Nenhuma legenda encontrada para: ${mediaId}`);
      return res.status(404).send('Legenda em inglês não encontrada.');
    }

    const enSub = subList.find(s => s.lang === 'en' || s.lang === 'eng') || subList[0];
    console.log(`[Legenda] A descarregar SRT original: ${enSub.url}`);

    // B. Descarregar o ficheiro SRT
    const srtDownload = await axios.get(enSub.url);
    const rawSrt = srtDownload.data;

    // C. Converter o SRT para objeto
    const parsedSrt = parser.fromSrt(rawSrt);
    const textsToTranslate = parsedSrt.map(item => item.text);

    console.log(`[Legenda] A traduzir ${textsToTranslate.length} linhas com o DeepL...`);

    // D. Traduzir em lotes (chunks) de 50 linhas para evitar erros no DeepL
    const CHUNK_SIZE = 50;
    let translatedTexts = [];

    for (let i = 0; i < textsToTranslate.length; i += CHUNK_SIZE) {
      const chunk = textsToTranslate.slice(i, i + CHUNK_SIZE);
      
      if (translator) {
        const results = await translator.translateText(chunk, null, 'pt-PT');
        translatedTexts.push(...results.map(r => r.text));
      } else {
        // Fallback caso a chave do DeepL não esteja definida
        translatedTexts.push(...chunk);
      }
    }

    // E. Reconstruir a estrutura do SRT com os textos traduzidos
    const translatedSrtObjects = parsedSrt.map((item, index) => ({
      ...item,
      text: translatedTexts[index] || item.text
    }));

    const finalSrt = parser.toSrt(translatedSrtObjects);

    console.log(`[Legenda] Tradução concluída com sucesso para: ${mediaId}`);
    return res.status(200).send(finalSrt);

  } catch (error) {
    console.error('[Legenda] Erro ao processar tradução:', error?.message || error);
    return res.status(500).send('Erro ao processar a tradução da legenda.');
  }
});

// 5. Integração do Router oficial do Stremio SDK
const addonInterface = builder.getInterface();
app.use('/', getRouter(addonInterface));

// 6. Arrancar o servidor
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Addon ativo na porta ${PORT}`));
