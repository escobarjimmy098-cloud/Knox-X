// server.js - AnimeSAO Pro Backend Optimizado v2
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.ANIMEFLV_BASE_URL || 'https://www3.animeflv.net';
const ALLOWED_GENRES = new Set([
    'accion', 'comedia', 'romance', 'fantasia', 'isekai', 'drama', 'shounen', 'misterio',
    'aventura', 'slice-of-life', 'seinen', 'shojo', 'magia', 'supernatural', 'psychological',
    'historico', 'mecha', 'ecchi', 'harem', 'military', 'music', 'sports'
]);

const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
}
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const isProduction = process.env.NODE_ENV === 'production';
const allowedOrigins = new Set([
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://localhost:3000',
    'https://127.0.0.1:3000',
    ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(origin => origin.trim()).filter(Boolean) : [])
]);

const corsOptions = {
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (!isProduction && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
            return callback(null, true);
        }
        if (allowedOrigins.has(origin)) {
            return callback(null, true);
        }
        return callback(new Error('No permitido por CORS'));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
};

app.use(compression());
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors(corsOptions));
app.use(express.json());

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 150,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Demasiadas solicitudes' }
});
app.use('/api/', limiter);

// ==================== CACHE INTELIGENTE ====================
const MAX_CACHE_ENTRIES = 500;
const cache = new Map();
const CACHE_TTL = {
    'latest': 5 * 60 * 1000,
    'trending': 15 * 60 * 1000,
    'genre': 10 * 60 * 1000,
    'search': 5 * 60 * 1000,
    'info': 60 * 60 * 1000,
    'video': 30 * 60 * 1000,
    'featured': 10 * 60 * 1000
};

const cacheGet = (key) => {
    const item = cache.get(key);
    if (!item) return null;
    const ttl = CACHE_TTL[key.split('_')[0]] || 15 * 60 * 1000;
    if (Date.now() - item.timestamp > ttl) {
        cache.delete(key);
        return null;
    }
    return item.data;
};

const cacheSet = (key, data) => {
    if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(key)) {
        const oldestKey = cache.keys().next().value;
        cache.delete(oldestKey);
    }
    cache.set(key, { data, timestamp: Date.now() });
};

// ==================== MIDDLEWARE ====================
const axiosInstance = axios.create({
    baseURL: BASE_URL,
    timeout: 20000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'es-MX,es;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://www3.animeflv.net/'
    }
});

// ==================== RETRY LOGIC ====================
const retryRequest = async (fn, maxRetries = 3) => {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            if (attempt === maxRetries - 1) throw error;
            const delayMs = Math.min(1000 * Math.pow(2, attempt), 5000);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
};

// ==================== UTILIDADES ====================
const validatePage = (page) => {
    const p = parseInt(page, 10);
    return (isNaN(p) || p < 1) ? 1 : p;
};

const validateGenre = (genre) => {
    if (!genre || typeof genre !== 'string') return null;
    const normalized = genre.toLowerCase().replace(/[^a-z0-9-]/g, '');
    return ALLOWED_GENRES.has(normalized) ? normalized : null;
};

const pickFirstText = ($, selectors, fallback = 'Sin título') => {
    for (const selector of selectors) {
        const text = $(selector).first().text().trim();
        if (text) return text;
    }
    return fallback;
};

const pickMetaContent = ($, selectors, fallback = '') => {
    for (const selector of selectors) {
        const value = $(selector).first().attr('content');
        if (value && String(value).trim()) return String(value).trim();
    }
    return fallback;
};

const normalizeAnime = (anime) => {
    return {
        id: anime.id || '',
        title: String(anime.title || 'Sin título').substring(0, 200),
        cover: String(anime.cover || ''),
        type: String(anime.type || 'Anime').substring(0, 50),
        rating: anime.rating ? String(anime.rating).substring(0, 10) : '',
        lastEpisode: anime.lastEpisode ? String(anime.lastEpisode).substring(0, 10) : ''
    };
};

const normalizeEpisode = (ep) => {
    return {
        number: ep.number || ep.ep || 0,
        id: ep.id || ep.slug || ''
    };
};

// ==================== DEDUPLICACIÓN ====================
const deduplicateAnimes = (animes) => {
    const seen = new Set();
    return animes.filter(anime => {
        if (!anime.id || seen.has(anime.id)) return false;
        seen.add(anime.id);
        return true;
    });
};

// ==================== ERROR HANDLER ====================
const handleApiError = (error, context) => {
    console.error(`[API] Error en ${context}:`, error.message);
    if (error.response) {
        console.error(`[API] Status: ${error.response.status}`);
    }
    return {
        success: false,
        error: `Error en ${context}`,
        data: context.includes('video') ? null : []
    };
};

// ==================== ENDPOINTS ====================

app.get('/api/latest', async (req, res) => {
    try {
        const page = validatePage(req.query.page);
        const nocache = req.query.nocache === 'true';
        const cacheKey = `latest_${page}`;
        
        if (!nocache) {
            let cachedData = cacheGet(cacheKey);
            if (cachedData) {
                return res.json({ success: true, data: cachedData });
            }
        }

        const data = await retryRequest(() => 
            axiosInstance.get(`/browse?order=added&page=${page}`)
        );
        
        const $ = cheerio.load(data.data);
        const animes = [];

        $('.ListAnimes li').each((i, el) => {
            const link = $(el).find('a').attr('href') || '';
            const id = link.replace('/anime/', '').trim();
            const imgSrc = $(el).find('img').attr('src') || '';
            const coverUrl = imgSrc.startsWith('http') ? imgSrc : `${BASE_URL}${imgSrc}`;
            const title = $(el).find('h3.Title').text().trim() || $(el).find('.Title').text().trim() || 'Sin título';
            
            if (id && id.length > 0) {
                animes.push(normalizeAnime({
                    id,
                    title,
                    cover: coverUrl,
                    type: $(el).find('.Type').text().trim()
                }));
            }
        });

        const deduplicated = deduplicateAnimes(animes);
        if (deduplicated.length === 0) {
            return res.json({ success: true, data: [] });
        }

        cacheSet(cacheKey, deduplicated);
        res.json({ success: true, data: deduplicated });
    } catch (error) {
        res.status(500).json(handleApiError(error, 'GET /api/latest'));
    }
});

app.get('/api/trending', async (req, res) => {
    try {
        const nocache = req.query.nocache === 'true';
        const cacheKey = 'trending';
        
        if (!nocache) {
            let cachedData = cacheGet(cacheKey);
            if (cachedData) {
                return res.json({ success: true, data: cachedData });
            }
        }

        const data = await retryRequest(() => axiosInstance.get('/'));
        const $ = cheerio.load(data.data);
        const animes = [];

        $('.ListAnimeTop li').each((i, el) => {
            const link = $(el).find('a').attr('href') || '';
            const id = link.replace('/anime/', '').trim();
            const imgSrc = $(el).find('img').attr('src') || '';
            const coverUrl = imgSrc.startsWith('http') ? imgSrc : `${BASE_URL}${imgSrc}`;
            
            if (id && id.length > 0) {
                animes.push(normalizeAnime({
                    id,
                    title: $(el).find('.Title').text().trim() || 'Sin título',
                    cover: coverUrl,
                    rating: $(el).find('.Votes').text().trim()
                }));
            }
        });

        if (animes.length === 0) {
            const trendingData = await retryRequest(() => 
                axiosInstance.get('/browse?order=rating&page=1')
            );
            const $trending = cheerio.load(trendingData.data);
            
            $trending('.ListAnimes li').each((i, el) => {
                if (i >= 20) return;
                const link = $trending(el).find('a').attr('href') || '';
                const id = link.replace('/anime/', '').trim();
                const imgSrc = $trending(el).find('img').attr('src') || '';
                const coverUrl = imgSrc.startsWith('http') ? imgSrc : `${BASE_URL}${imgSrc}`;
                
                if (id && id.length > 0) {
                    animes.push(normalizeAnime({
                        id,
                        title: $trending(el).find('.Title').text().trim() || 'Sin título',
                        cover: coverUrl,
                        rating: '9.0'
                    }));
                }
            });
        }

        const deduplicated = deduplicateAnimes(animes);
        if (deduplicated.length === 0) {
            return res.json({ success: true, data: [] });
        }

        cacheSet(cacheKey, deduplicated);
        res.json({ success: true, data: deduplicated });
    } catch (error) {
        res.status(500).json(handleApiError(error, 'GET /api/trending'));
    }
});

app.get('/api/genre/:genre', async (req, res) => {
    try {
        const genre = validateGenre(req.params.genre);
        const page = validatePage(req.query.page);
        const nocache = req.query.nocache === 'true';
        
        if (!genre) {
            return res.status(400).json({ success: false, error: 'Género inválido', data: [] });
        }

        const cacheKey = `genre_${genre}_${page}`;
        if (!nocache) {
            let cachedData = cacheGet(cacheKey);
            if (cachedData) {
                return res.json({ success: true, data: cachedData });
            }
        }

        const data = await retryRequest(() =>
            axiosInstance.get(`/browse?genre[]=${genre}&order=default&page=${page}`)
        );
        
        const $ = cheerio.load(data.data);
        const animes = [];

        $('.ListAnimes li').each((i, el) => {
            const link = $(el).find('a').attr('href') || '';
            const id = link.replace('/anime/', '').trim();
            const imgSrc = $(el).find('img').attr('src') || '';
            const coverUrl = imgSrc.startsWith('http') ? imgSrc : `${BASE_URL}${imgSrc}`;
            const title = $(el).find('h3.Title').text().trim() || $(el).find('.Title').text().trim() || 'Sin título';
            
            if (id && id.length > 0) {
                animes.push(normalizeAnime({
                    id,
                    title,
                    cover: coverUrl,
                    type: $(el).find('.Type').text().trim()
                }));
            }
        });

        const deduplicated = deduplicateAnimes(animes);
        if (deduplicated.length === 0) {
            return res.json({ success: true, data: [] });
        }

        cacheSet(cacheKey, deduplicated);
        res.json({ success: true, data: deduplicated });
    } catch (error) {
        res.status(500).json(handleApiError(error, 'GET /api/genre'));
    }
});

app.get('/api/search', async (req, res) => {
    try {
        const { q } = req.query;
        
        if (!q || typeof q !== 'string' || q.trim().length === 0) {
            return res.status(400).json({ success: false, error: 'Query inválida', data: [] });
        }

        const query = q.trim().substring(0, 100);
        const cacheKey = `search_${query}`;
        
        let cachedData = cacheGet(cacheKey);
        if (cachedData) {
            return res.json({ success: true, data: cachedData });
        }

        const data = await retryRequest(() =>
            axiosInstance.get(`/browse?q=${encodeURIComponent(query)}`)
        );
        
        const $ = cheerio.load(data.data);
        const animes = [];

        $('.ListAnimes li').each((i, el) => {
            const link = $(el).find('a').attr('href') || '';
            const id = link.replace('/anime/', '').trim();
            const imgSrc = $(el).find('img').attr('src') || '';
            const coverUrl = imgSrc.startsWith('http') ? imgSrc : `${BASE_URL}${imgSrc}`;
            const title = $(el).find('h3.Title').text().trim() || $(el).find('.Title').text().trim() || 'Sin título';
            
            if (id && id.length > 0) {
                animes.push(normalizeAnime({
                    id,
                    title,
                    cover: coverUrl,
                    type: $(el).find('.Type').text().trim()
                }));
            }
        });

        const deduplicated = deduplicateAnimes(animes);
        if (deduplicated.length === 0) {
            return res.json({ success: true, data: [] });
        }

        cacheSet(cacheKey, deduplicated);
        res.json({ success: true, data: deduplicated });
    } catch (error) {
        res.status(500).json(handleApiError(error, 'GET /api/search'));
    }
});

app.get('/api/info/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        if (!id || typeof id !== 'string' || id.length === 0) {
            return res.status(400).json({ success: false, error: 'ID inválido', data: null });
        }

        const cleanId = id.replace(/\//g, '').substring(0, 100);
        const cacheKey = `info_${cleanId}`;
        
        let cachedData = cacheGet(cacheKey);
        if (cachedData) {
            return res.json({ success: true, data: cachedData });
        }

        const data = await retryRequest(() =>
            axiosInstance.get(`/anime/${cleanId}`)
        );
        
        const $ = cheerio.load(data.data);
        const episodes = [];
        const scripts = $('script');
        
        scripts.each((i, el) => {
            const contents = $(el).html() || '';
            if (contents.includes('var episodes =')) {
                const match = contents.match(/var episodes\s*=\s*(\[.*?\]);/i);
                if (match) {
                    try {
                        const rawEps = JSON.parse(match[1]);
                        rawEps.forEach(re => {
                            const epNum = Array.isArray(re) ? re[0] : (re.ep || re.numero || re.number);
                            const epId = Array.isArray(re) ? re[1] : (re.id || re.slug);
                            if (epNum !== undefined && epNum !== null) {
                                episodes.push(normalizeEpisode({ number: epNum, id: epId }));
                            }
                        });
                    } catch (err) {
                        console.error('[API] Error parseando episodios:', err.message);
                    }
                }
            }
        });

        const genres = [];
        $('.Nvgnrs a').each((i, el) => {
            const g = $(el).text().trim();
            if (g) genres.push(g.substring(0, 50));
        });

        let coverUrl = '';
        const coverImg = $('.AnimeCover img').attr('src');
        if (coverImg) {
            coverUrl = coverImg.startsWith('http') ? coverImg : `${BASE_URL}${coverImg}`;
        }
        if (!coverUrl) {
            const altImg = $('img[alt*="Cover"], img[alt*="cover"]').first().attr('src');
            if (altImg) {
                coverUrl = altImg.startsWith('http') ? altImg : `${BASE_URL}${altImg}`;
            }
        }
        if (!coverUrl) {
            const metaImage = pickMetaContent($, [
                'meta[property="og:image"]',
                'meta[name="twitter:image"]',
                'meta[property="og:image:secure_url"]'
            ]);
            if (metaImage) {
                coverUrl = metaImage.startsWith('http') ? metaImage : `${BASE_URL}${metaImage}`;
            }
        }

        const titleText = pickFirstText($, [
            'h1.Title',
            '.Ficha.fcont .Title',
            '.Ficha.fcont h2',
            '.container .Title',
            'h1',
            '.AnimeName',
            '.Title'
        ], '') || pickMetaContent($, [
            'meta[property="og:title"]',
            'meta[name="twitter:title"]',
            'meta[name="title"]'
        ], 'Sin título') || $('title').text().replace(/\s*\|.*$/, '').trim() || 'Sin título';

        const info = {
            id: cleanId,
            title: titleText,
            cover: coverUrl,
            synopsis: $('.Description p').text().trim() || 'Sin sinopsis',
            status: $('.AnmStts span').text().trim() || 'Desconocido',
            genres: genres.slice(0, 10),
            episodes: episodes.reverse().slice(0, 500)
        };

        cacheSet(cacheKey, info);
        res.json({ success: true, data: info });
    } catch (error) {
        res.status(500).json(handleApiError(error, 'GET /api/info'));
    }
});

app.get('/api/video/:id/:cap', async (req, res) => {
    try {
        let { id, cap } = req.params;
        
        if (!id || !cap) {
            return res.status(400).json({ success: false, error: 'Parámetros inválidos', data: null });
        }

        const cleanSlug = id.replace(/\//g, '').substring(0, 100);
        const cleanCap = cap.replace(/\D/g, '').substring(0, 10);

        if (!cleanCap) {
            return res.status(400).json({ success: false, error: 'Capítulo inválido', data: null });
        }

        const cacheKey = `video_${cleanSlug}_${cleanCap}`;
        let cachedData = cacheGet(cacheKey);
        if (cachedData) {
            return res.json({ success: true, data: cachedData });
        }

        const data = await retryRequest(() =>
            axiosInstance.get(`/ver/${cleanSlug}-${cleanCap}`)
        );
        
        const $ = cheerio.load(data.data);
        let servers = [];
        const scripts = $('script');
        
        scripts.each((i, el) => {
            const scriptData = $(el).html() || '';
            if (scriptData.includes('var videos =')) {
                const match = scriptData.match(/var videos\s*=\s*(\{.*?\});/i);
                if (match && match[1]) {
                    try {
                        const videoData = JSON.parse(match[1]);
                        if (videoData.SUB && Array.isArray(videoData.SUB)) {
                            servers = videoData.SUB
                                .map(s => ({
                                    name: (s.title || s.server || 'Servidor').substring(0, 50),
                                    url: s.code && s.code.includes('http') 
                                        ? s.code 
                                        : `https://streamwish.to/e/${s.code || ''}`,
                                    priority: s.priority || 0
                                }))
                                .filter(s => s.url && s.url.length > 10)
                                .sort((a, b) => b.priority - a.priority)
                                .slice(0, 10);
                        }
                    } catch (err) {
                        console.error('[API] Error parseando videos:', err.message);
                    }
                }
            }
        });

        if (servers.length === 0) {
            return res.status(404).json({ success: false, error: 'Video no disponible', data: null });
        }

        const result = { servers };
        cacheSet(cacheKey, result);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json(handleApiError(error, 'GET /api/video'));
    }
});

app.get('/api/health', (req, res) => {
    res.json({ success: true, status: 'online', cached_items: cache.size });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[AnimeSAO Pro] Servidor listo en puerto ${PORT}`);
    console.log(`[AnimeSAO Pro] Cache dinámico habilitado`);
});
