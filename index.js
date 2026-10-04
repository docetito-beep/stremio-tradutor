const express = require('express');
const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const Parser = require('srt-parser-2').default;
const deepl = require('deepl-node');

const app = express();
const parser = new Parser();

// Configura a chave da API do DeepL se estiver definida nas variáveis de ambiente
const translator = process.env.DEEPL_API_KEY 
  ? new deepl.Translator(process.env.DEEPL_API_KEY) 
  : null;

// 1. Definição do Manifesto do Stremio
const manifest = {
  id: 'org.comunidade.tradutor.ptpt',
  version: '1.0.0',
  name: 'Tradutor de Legendas (EN -> PT-PT)',
  description: 'Traduz automaticamente legendas de Inglês para Português de Portugal.',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt']
};

const builder = new addonBuilder(manifest);

// 2. Handler de Legendas
builder.defineSubtitlesHandler(async ({ type, id }) => {
  const host = process.env.PUBLIC_URL || 'http://localhost:7000';
  
  return Promise.resolve({
    subtitles: [
      {
        id: `ptpt_${id}`,
        url: `${host}/translate.srt?id=${id}`,
        lang: 'por', // Código para Português no Stremio
        label: '🇵🇹 Português (Traduzido PT-PT)'
      }
    ]
  });
});

// Integra o SDK com o Express
const addonInterface = builder.getInterface();
app.get('/manifest.json', (req, res) => res.json(addonInterface.manifest));
app.get('/subtitles/:type/:id/:extra?.json', (req, res) => {
  addonInterface.get('subtitles', req.params.type, req.params.id, (err, resData) => {
    if (err) return res.status(500).send(err);
    res.json(resData);
  });
});

// 3. Endpoint que procura a legenda em inglês, traduz e devolve em SRT
app.get('/translate.srt', async (req, res) => {
  const mediaId = req.query.id;
  try {
    // Procura a legenda original em Inglês
    const subSearch = await axios.get(`https://sub.wyzie.ru/search?id=${mediaId}`);
    const enSub = subSearch.data?.find(s => s.lang === 'en' || s.lang === 'eng');

    if (!enSub || !enSub.url) {
      return res.status(404).send('Legenda em inglês não encontrada.');
    }

    // Descarrega e converte o SRT para objeto
    const srtContent = (await axios.get(enSub.url)).data;
    const parsedSrt = parser.fromSrt(srtContent);

    const textsToTranslate = parsedSrt.map(item => item.text);
    let translatedTexts = [];

    if (translator) {
      // Tradução direta em bloco para PT-PT
      const results = await translator.translateText(textsToTranslate, 'en', 'pt-PT');
      translatedTexts = results.map(r => r.text);
    } else {
      translatedTexts = textsToTranslate; 
    }

    // Reconstrói o ficheiro SRT com o texto traduzido
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
