// script.js - AnimeSAO Pro Premium Experience v2
const API_BASE = '/api';
const SECTIONS_CONFIG = [
    { id: 'latest', title: 'Añadidos Recientemente', type: 'latest', endpoint: 'latest' },
    { id: 'trending', title: 'Animes Populares', type: 'trending', endpoint: 'trending' },
    { id: 'action', title: 'Acción', type: 'genre', endpoint: 'genre/accion' },
    { id: 'comedy', title: 'Comedia', type: 'genre', endpoint: 'genre/comedia' },
    { id: 'romance', title: 'Romance', type: 'genre', endpoint: 'genre/romance' },
    { id: 'fantasy', title: 'Fantasía', type: 'genre', endpoint: 'genre/fantasia' },
    { id: 'isekai', title: 'Isekai', type: 'genre', endpoint: 'genre/isekai' },
    { id: 'drama', title: 'Drama', type: 'genre', endpoint: 'genre/drama' },
    { id: 'shounen', title: 'Shounen', type: 'genre', endpoint: 'genre/shounen' },
    { id: 'mystery', title: 'Misterio', type: 'genre', endpoint: 'genre/misterio' }
];

// ==================== STATE ====================
const AppState = {
    library: JSON.parse(localStorage.getItem('anime_library') || '[]'),
    history: JSON.parse(localStorage.getItem('anime_history') || '[]'),
    userPreferences: JSON.parse(localStorage.getItem('anime_prefs') || '{}'),
    currentAnime: null,
    currentEpisode: null,
    currentServers: [],
    currentServerIndex: 0,
    playerProgress: {},
    homeSections: new Map(),
    homeLoading: false,
    homeInitialized: false,
    sectionsLoading: new Set(),
    sectionPageCache: new Map(),
    categoryType: null,
    categoryGenre: null,
    categoryPage: 1,
    categoryLoading: false,
    categoryHasMore: true,
    searchTimeout: null,
    searchCache: new Map(),
    playerLoading: false,
    playerError: null,
    seenAnimeIds: new Set(),
    toastTimer: null
};

// ==================== UTILITIES ====================
const $ = (id) => document.getElementById(id);

const showToast = (msg, duration = 2400) => {
    const toast = $('toast');
    if (!toast) return;

    clearTimeout(AppState.toastTimer);
    toast.textContent = msg;
    toast.classList.add('show');

    AppState.toastTimer = setTimeout(() => {
        toast.classList.remove('show');
        toast.textContent = '';
    }, duration);
};

const debounce = (fn, ms) => {
    let timer;
    return function(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const shuffleArray = (array) => {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
};

// ==================== X.AGENTE - MOTOR CENTRAL DE RECOMENDACIONES ====================
const XAgente = {
    agentKey: 'x_agente_state_v1',
    updateIntervalMs: 45000, // 45 segundos
    updateTimerId: null,
    agentActive: true,
    explorationThreshold: 40, // 40% exploración
    exploitationThreshold: 60, // 60% explotación
    
    _loadState() {
        try {
            return JSON.parse(localStorage.getItem(this.agentKey) || '{}');
        } catch {
            return {};
        }
    },
    
    _saveState(state) {
        localStorage.setItem(this.agentKey, JSON.stringify(state));
    },
    
    _generateUniqueId(anime) {
        if (anime.id) return String(anime.id);
        const str = `${anime.title}${anime.type}${anime.rating}`;
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return `anime_${Math.abs(hash)}`;
    },
    
    _evaluateDataSufficiency() {
        const candidates = AppState.library.length + AppState.history.length;
        return candidates >= 5; // Mínimo 5 interacciones
    },
    
    _calculatePenalty(anime) {
        const state = this._loadState();
        const animeId = this._generateUniqueId(anime);
        const lastSeen = state[animeId]?.lastSeen || 0;
        const viewCount = state[animeId]?.viewCount || 0;
        
        // Penalización por recencia (si fue visto hace poco)
        const timeSinceView = Date.now() - lastSeen;
        const recencyPenalty = Math.max(0, 1 - (timeSinceView / (24 * 60 * 60 * 1000)));
        
        // Penalización por exceso de vistas
        const frequencyPenalty = Math.min(0.5, viewCount * 0.1);
        
        return recencyPenalty + frequencyPenalty;
    },
    
    _calculateReward(anime, userInteraction) {
        // Recompensa por: favoritos, vistas nuevas, mejor rating, nuevas características
        let reward = 0;
        
        if (userInteraction.isFavorite) reward += 2.0;
        if (userInteraction.isNew) reward += 1.5;
        if (userInteraction.hasNewGenres) reward += 1.2;
        if (userInteraction.highRating) reward += 1.0;
        
        return reward;
    },
    
    _recordInteraction(anime) {
        const state = this._loadState();
        const animeId = this._generateUniqueId(anime);
        
        state[animeId] = {
            id: animeId,
            title: anime.title,
            lastSeen: Date.now(),
            viewCount: (state[animeId]?.viewCount || 0) + 1,
            totalReward: (state[animeId]?.totalReward || 0),
            totalPenalty: (state[animeId]?.totalPenalty || 0)
        };
        
        this._saveState(state);
    },
    
    shouldUpdate() {
        if (!this.agentActive) return false;
        return this._evaluateDataSufficiency();
    },
    
    async autonomousUpdate() {
        if (!this.shouldUpdate()) return false;
        
        const exploration = this.explorationThreshold;
        const exploitation = this.exploitationThreshold;
        
        const state = this._loadState();
        const timestamp = Date.now();
        
        state.lastUpdate = timestamp;
        state.updateCount = (state.updateCount || 0) + 1;
        state.currentExploration = exploration;
        state.currentExploitation = exploitation;
        
        this._saveState(state);
        return true;
    },
    
    recordReward(animeId, reward) {
        const state = this._loadState();
        if (state[animeId]) {
            state[animeId].totalReward = (state[animeId].totalReward || 0) + reward;
        }
        this._saveState(state);
    },
    
    recordPenalty(animeId, penalty) {
        const state = this._loadState();
        if (state[animeId]) {
            state[animeId].totalPenalty = (state[animeId].totalPenalty || 0) + penalty;
        }
        this._saveState(state);
    },
    
    startAgent() {
        if (this.updateTimerId) return;
        
        this.agentActive = true;
        this.updateTimerId = setInterval(async () => {
            const updated = await this.autonomousUpdate();
            if (updated) {
                HomeManager.renderPersonalizedSection(true);
            }
        }, this.updateIntervalMs);
    },
    
    stopAgent() {
        if (this.updateTimerId) {
            clearInterval(this.updateTimerId);
            this.updateTimerId = null;
        }
        this.agentActive = false;
    }
};

// ==================== X.EY - MOTOR INTELIGENTE DE BÚSQUEDA ====================
const XEy = {
    searchMemoryKey: 'x_ey_search_memory_v1',
    contextKey: 'x_ey_context_v1',
    maxMemory: 50,
    
    _loadSearchMemory() {
        try {
            return JSON.parse(localStorage.getItem(this.searchMemoryKey) || '[]');
        } catch {
            return [];
        }
    },
    
    _saveSearchMemory(memory) {
        localStorage.setItem(this.searchMemoryKey, JSON.stringify(memory));
    },
    
    _loadContext() {
        try {
            return JSON.parse(localStorage.getItem(this.contextKey) || '{}');
        } catch {
            return {};
        }
    },
    
    _saveContext(context) {
        localStorage.setItem(this.contextKey, JSON.stringify(context));
    },
    
    _extractSearchPattern(query) {
        const genres = [];
        const years = [];
        const types = [];
        
        const genreMap = ['accion', 'comedia', 'romance', 'fantasia', 'isekai', 'drama', 'shounen', 'misterio', 'aventura', 'seinen', 'shojo'];
        genreMap.forEach(g => {
            if (query.toLowerCase().includes(g)) genres.push(g);
        });
        
        const yearMatches = query.match(/\b(19|20)\d{2}\b/g);
        if (yearMatches) years.push(...yearMatches.map(Number));
        
        const typeKeywords = ['manga', 'ova', 'especial', 'película', 'tv'];
        typeKeywords.forEach(t => {
            if (query.toLowerCase().includes(t)) types.push(t);
        });
        
        return { genres, years, types, rawQuery: query };
    },
    
    recordSearch(query, resultsCount, selectedResult = null) {
        const memory = this._loadSearchMemory();
        const pattern = this._extractSearchPattern(query);
        
        const record = {
            timestamp: Date.now(),
            query,
            pattern,
            resultsCount,
            selectedResult,
            successful: resultsCount > 0
        };
        
        memory.unshift(record);
        if (memory.length > this.maxMemory) memory.pop();
        
        this._saveSearchMemory(memory);
        this._updateContext(pattern);
    },
    
    _updateContext(pattern) {
        const context = this._loadContext();
        
        pattern.genres.forEach(g => {
            context[`genre_${g}`] = (context[`genre_${g}`] || 0) + 1;
        });
        pattern.years.forEach(y => {
            context[`year_${y}`] = (context[`year_${y}`] || 0) + 1;
        });
        pattern.types.forEach(t => {
            context[`type_${t}`] = (context[`type_${t}`] || 0) + 1;
        });
        
        this._saveContext(context);
    },
    
    getSuggestions(partialQuery = '') {
        const memory = this._loadSearchMemory();
        const seen = new Set();
        const suggestions = [];
        
        memory.forEach(record => {
            if (record.successful && record.query.toLowerCase().includes(partialQuery.toLowerCase())) {
                if (!seen.has(record.query)) {
                    suggestions.push(record.query);
                    seen.add(record.query);
                }
            }
        });
        
        return suggestions.slice(0, 8);
    },
    
    getContextualRecommendations(query) {
        const pattern = this._extractSearchPattern(query);
        const context = this._loadContext();
        
        // Buscar animes que coincidan con el patrón detectado
        const all = HomeManager.getAllLoadedItems();
        const relevant = all.filter(anime => {
            const animeGenres = (anime.genres || []).map(g => normalizeText(g));
            const matchedGenres = pattern.genres.filter(g => animeGenres.includes(g)).length;
            return matchedGenres > 0 || pattern.rawQuery.toLowerCase() === anime.title.toLowerCase();
        });
        
        return Recommendations.rankItems(relevant).slice(0, 10);
    }
};

// ==================== X.VITALS - MONITOR DE VITALIDAD DE CONTENIDO ====================
const XVitals = {
    vitalsKey: 'x_vitals_status_v1',
    checkIntervalMs: 60000, // 1 minuto
    checkTimerId: null,
    
    _loadVitals() {
        try {
            return JSON.parse(localStorage.getItem(this.vitalsKey) || '{}');
        } catch {
            return {};
        }
    },
    
    _saveVitals(vitals) {
        localStorage.setItem(this.vitalsKey, JSON.stringify(vitals));
    },
    
    _analyzeContentHealth(anime) {
        const score = {
            animeId: anime.id,
            title: anime.title,
            health: 0, // 0-100
            vitality: 0, // 0-100
            popularity: 0, // 0-100
            engagement: 0 // 0-100
        };
        
        // Health: basado en rating y estado
        const rating = parseFloat(anime.rating) || 0;
        score.health = Math.min(100, (rating / 10) * 100);
        
        // Vitality: basado en episodios disponibles
        const episodes = parseInt(anime.lastEpisode) || 0;
        score.vitality = Math.min(100, (episodes / 50) * 100);
        
        // Popularity: si está en biblioteca o historial
        const inLibrary = AppState.library.some(a => a.id === anime.id) ? 30 : 0;
        const inHistory = AppState.history.some(a => a.id === anime.id) ? 40 : 0;
        score.popularity = Math.min(100, inLibrary + inHistory);
        
        // Engagement: promedio de todo
        score.engagement = Math.round((score.health + score.vitality + score.popularity) / 3);
        
        return score;
    },
    
    analyzeAll() {
        const vitals = this._loadVitals();
        const candidates = HomeManager.getAllLoadedItems();
        
        candidates.forEach(anime => {
            const health = this._analyzeContentHealth(anime);
            vitals[anime.id] = health;
        });
        
        this._saveVitals(vitals);
        return vitals;
    },
    
    getDeadContent() {
        const vitals = this._loadVitals();
        return Object.values(vitals).filter(v => v.engagement < 30);
    },
    
    getAliveContent() {
        const vitals = this._loadVitals();
        return Object.values(vitals).filter(v => v.engagement >= 70);
    },
    
    startMonitoring() {
        if (this.checkTimerId) return;
        this.checkTimerId = setInterval(() => {
            this.analyzeAll();
        }, this.checkIntervalMs);
    },
    
    stopMonitoring() {
        if (this.checkTimerId) {
            clearInterval(this.checkTimerId);
            this.checkTimerId = null;
        }
    }
};

// ==================== RECOMENDACIONES AVANZADAS ====================
const Recommendations = {
    profileKey: 'anime_reco_profile_v3',
    sessionKey: 'anime_reco_session_v3',
    explorationRate: 0.4, // 40% exploración
    exploitationRate: 0.6, // 60% explotación
    diversityThreshold: 0.7, // Umbral para diversidad de géneros
    maxRecommendations: 20,
    
    _loadProfile() {
        try {
            const profile = JSON.parse(localStorage.getItem(this.profileKey) || '{}');
            return {
                genres: profile.genres || {},
                tokens: profile.tokens || {},
                types: profile.types || {},
                statuses: profile.statuses || {},
                years: profile.years || {},
                ratings: profile.ratings || {},
                favorites: profile.favorites || {},
                views: profile.views || {},
                lastUpdated: profile.lastUpdated || Date.now(),
                totalViews: profile.totalViews || 0,
                sessionCount: profile.sessionCount || 0
            };
        } catch {
            return { 
                genres: {}, tokens: {}, types: {}, statuses: {}, years: {}, ratings: {}, 
                favorites: {}, views: {}, lastUpdated: Date.now(), totalViews: 0, sessionCount: 0 
            };
        }
    },
    
    _saveProfile(profile) {
        profile.lastUpdated = Date.now();
        localStorage.setItem(this.profileKey, JSON.stringify(profile));
    },
    
    _loadSession() {
        try {
            return JSON.parse(localStorage.getItem(this.sessionKey) || '{}');
        } catch {
            return {};
        }
    },
    
    _saveSession(session) {
        localStorage.setItem(this.sessionKey, JSON.stringify(session));
    },
    
    _touchBucket(bucket, key, weight = 1) {
        if (!key) return;
        bucket[key] = (bucket[key] || 0) + weight;
    },
    
    _getSessionSeed(forceNew = false) {
        const session = this._loadSession();
        const now = Date.now();
        if (forceNew || !session.day || now - session.day > 24 * 60 * 60 * 1000) {
            session.day = now;
            session.seed = Math.random();
            session.refreshCount = (session.refreshCount || 0) + 1;
            this._saveSession(session);
        }
        return session.seed;
    },
    
    _extractFeatures(anime) {
        const year = anime.title ? anime.title.match(/\b(19|20)\d{2}\b/)?.[0] : null;
        const rating = safeNumber(anime.rating, 0);
        return {
            genres: (anime.genres || []).map(g => normalizeText(g)),
            type: normalizeText(anime.type || ''),
            status: normalizeText(anime.status || ''),
            year: year ? parseInt(year) : null,
            rating: rating,
            tokens: buildAnimeTokens(anime)
        };
    },
    
    registerAnime(anime, weight = 1) {
        if (!anime || !anime.id) return;
        const profile = this._loadProfile();
        const features = this._extractFeatures(anime);
        
        features.genres.forEach(genre => this._touchBucket(profile.genres, genre, weight * 2.5));
        if (features.type) this._touchBucket(profile.types, features.type, weight * 0.8);
        if (features.status) this._touchBucket(profile.statuses, features.status, weight * 0.6);
        if (features.year) this._touchBucket(profile.years, features.year, weight * 0.4);
        if (features.rating > 0) this._touchBucket(profile.ratings, Math.floor(features.rating), weight * 0.3);
        features.tokens.forEach(token => this._touchBucket(profile.tokens, token, weight * 0.2));
        
        this._touchBucket(profile.views, anime.id, weight);
        profile.totalViews += weight;
        profile.sessionCount++;
        
        this._saveProfile(profile);
    },
    
    registerFavorite(anime, isFavorite = true) {
        if (!anime || !anime.id) return;
        const profile = this._loadProfile();
        const weight = isFavorite ? 4.0 : 1.5;
        const features = this._extractFeatures(anime);
        
        features.genres.forEach(genre => this._touchBucket(profile.genres, genre, weight * 3.0));
        features.tokens.forEach(token => this._touchBucket(profile.tokens, token, weight * 0.4));
        this._touchBucket(profile.favorites, anime.id, isFavorite ? 1 : -1);
        
        this._saveProfile(profile);
    },
    
    updateWeights(genres, anime = null, weight = 1) {
        if (!Array.isArray(genres) || genres.length === 0) return;
        const profile = this._loadProfile();
        genres.forEach(genre => this._touchBucket(profile.genres, normalizeText(genre), weight * 2.0));
        if (anime) {
            this.registerAnime(anime, weight * 0.9);
        } else {
            this._saveProfile(profile);
        }
    },
    
    getTopSignals() {
        const profile = this._loadProfile();
        const topGenres = Object.entries(profile.genres).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
        const topTokens = Object.entries(profile.tokens).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
        const topYears = Object.entries(profile.years).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);
        return { topGenres, topTokens, topYears };
    },
    
    scoreAnime(anime) {
        if (!anime || !anime.id) return 0;
        const profile = this._loadProfile();
        const features = this._extractFeatures(anime);
        let score = 0;
        
        // Puntuación por géneros
        features.genres.forEach(genre => {
            score += (profile.genres[genre] || 0) * 2.2;
        });
        
        // Puntuación por tokens (palabras clave)
        features.tokens.forEach(token => {
            score += (profile.tokens[token] || 0) * 0.6;
        });
        
        // Puntuación por tipo y estado
        if (features.type && profile.types[features.type]) {
            score += profile.types[features.type] * 1.0;
        }
        if (features.status && profile.statuses[features.status]) {
            score += profile.statuses[features.status] * 0.7;
        }
        
        // Puntuación por año y rating
        if (features.year && profile.years[features.year]) {
            score += profile.years[features.year] * 0.5;
        }
        if (features.rating > 0 && profile.ratings[Math.floor(features.rating)]) {
            score += profile.ratings[Math.floor(features.rating)] * 0.4;
        }
        
        // Bonus por estar en biblioteca o historial
        if (AppState.library.some(item => item.id === anime.id)) {
            score += 5.0;
        }
        
        const historyItem = AppState.history.find(item => item.id === anime.id);
        if (historyItem) {
            const recencyBoost = Math.max(0, 1 - ((Date.now() - (historyItem.lastUpdated || historyItem.timestamp || 0)) / (1000 * 60 * 60 * 24 * 7)));
            score += 3.0 + recencyBoost * 2.5;
        }
        
        // Factor de novedad (para exploración)
        const viewCount = profile.views[anime.id] || 0;
        if (viewCount === 0) {
            score += 1.5; // Bonus por ser nuevo
        }
        
        return score;
    },
    
    _calculateDiversityScore(anime, recentAnimes = []) {
        if (recentAnimes.length === 0) return 1;
        const features = this._extractFeatures(anime);
        let diversityScore = 0;
        
        recentAnimes.forEach(recent => {
            const recentFeatures = this._extractFeatures(recent);
            const genreOverlap = features.genres.filter(g => recentFeatures.genres.includes(g)).length;
            const typeMatch = features.type === recentFeatures.type ? 1 : 0;
            diversityScore += (genreOverlap * 0.6 + typeMatch * 0.4);
        });
        
        return 1 - (diversityScore / recentAnimes.length);
    },
    
    rankItems(items = [], context = 'general', forceNewSeed = false) {
        const profile = this._loadProfile();
        const sessionSeed = this._getSessionSeed(forceNewSeed);
        const now = Date.now();
        
        // Usar umbrales de X.AGENTE
        const exploitationRate = XAgente.exploitationThreshold / 100;
        const explorationRate = XAgente.explorationThreshold / 100;
        
        // Filtrar items únicos
        const uniqueItems = uniqueById(items);
        
        // Calcular scores base con penalizaciones de X.AGENTE
        const scoredItems = uniqueItems.map(item => {
            const baseScore = this.scoreAnime(item);
            const animeId = XAgente._generateUniqueId(item);
            const penalty = XAgente._calculatePenalty(item);
            
            return {
                ...item,
                __score: Math.max(0, baseScore - penalty),
                __diversity: this._calculateDiversityScore(item, AppState.history.slice(0, 5)),
                __hash: hashString(item.id || item.title || ''),
                __random: (hashString(item.id + sessionSeed) % 1000) / 1000,
                __animeId: animeId
            };
        });
        
        // Aplicar balance explotación vs exploración (40% vs 60%)
        const exploitationItems = scoredItems
            .filter(item => item.__score > 0)
            .sort((a, b) => b.__score - a.__score)
            .slice(0, Math.floor(this.maxRecommendations * exploitationRate));
        
        const explorationItems = scoredItems
            .filter(item => !exploitationItems.some(e => e.id === item.id))
            .sort((a, b) => {
                // Mezcla de diversidad, novedad y aleatoriedad
                const aScore = a.__diversity * 0.4 + (1 - (profile.views[a.id] || 0) / Math.max(profile.totalViews, 1)) * 0.3 + a.__random * 0.3;
                const bScore = b.__diversity * 0.4 + (1 - (profile.views[b.id] || 0) / Math.max(profile.totalViews, 1)) * 0.3 + b.__random * 0.3;
                return bScore - aScore;
            })
            .slice(0, Math.floor(this.maxRecommendations * explorationRate));
        
        // Combinar y ordenar final
        const combined = [...exploitationItems, ...explorationItems];
        
        // Aplicar diversidad final
        const finalRanked = [];
        const usedGenres = new Set();
        
        combined.forEach(item => {
            const itemGenres = this._extractFeatures(item).genres;
            const genreOverlap = itemGenres.filter(g => usedGenres.has(g)).length / Math.max(itemGenres.length, 1);
            
            if (genreOverlap < this.diversityThreshold || finalRanked.length < 5) {
                finalRanked.push(item);
                itemGenres.forEach(g => usedGenres.add(g));
            }
        });
        
        // Ordenar final por score ajustado
        finalRanked.sort((a, b) => {
            const aAdjusted = a.__score + a.__diversity * 0.5;
            const bAdjusted = b.__score + b.__diversity * 0.5;
            if (Math.abs(aAdjusted - bAdjusted) > 0.1) return bAdjusted - aAdjusted;
            return a.__hash - b.__hash;
        });
        
        return finalRanked.slice(0, this.maxRecommendations).map(({ __score, __diversity, __hash, __random, __animeId, ...item }) => item);
    },
    
    getProfile() {
        return this._loadProfile();
    },
    
    resetProfile() {
        localStorage.removeItem(this.profileKey);
        localStorage.removeItem(this.sessionKey);
        showToast('Perfil de recomendaciones reiniciado');
    }
};

// ==================== API ====================
const API = {
    requestCache: new Map(),
    
    async fetch(endpoint, params = {}) {
        try {
            const queryString = new URLSearchParams(params).toString();
            const url = `${API_BASE}/${endpoint}${queryString ? '?' + queryString : ''}`;
            
            if (params.nocache) {
                const res = await fetch(url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return await res.json();
            }

            if (this.requestCache.has(url)) {
                return this.requestCache.get(url);
            }
            
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            
            this.requestCache.set(url, data);
            setTimeout(() => this.requestCache.delete(url), 3 * 60 * 1000);
            
            return data;
        } catch (err) {
            console.error('[API Error]', err);
            return { success: false, error: err.message, data: null };
        }
    },

    getLatest(page = 1, nocache = false) {
        return this.fetch('latest', { page, nocache });
    },

    getTrending(nocache = false) {
        return this.fetch('trending', { nocache });
    },

    getGenre(genre, page = 1, nocache = false) {
        return this.fetch(`genre/${genre}`, { page, nocache });
    },

    search(query) {
        return this.fetch('search', { q: query });
    },

    getInfo(id) {
        const cleanId = id.replace('/anime/', '');
        return this.fetch(`info/${cleanId}`);
    },

    getVideo(id, cap) {
        const cleanId = id.replace('/anime/', '');
        return this.fetch(`video/${cleanId}/${cap}`);
    }
};

// ==================== UI BUILDER ====================
const UIBuilder = {
    buildCard(anime, isHistory = false) {
        const card = document.createElement('div');
        card.className = 'card';

        const wrapper = document.createElement('div');
        wrapper.className = 'card-img-wrapper';

        if (anime.lastEpisode && anime.lastEpisode !== '?') {
            const epTag = document.createElement('div');
            epTag.className = 'ep-tag';
            epTag.textContent = `EP ${anime.lastEpisode}`;
            wrapper.appendChild(epTag);
        }

        const coverUrl = anime.cover && anime.cover.length > 0
            ? anime.cover
            : 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

        const img = document.createElement('img');
        img.src = coverUrl;
        img.alt = anime.title || 'Portada de anime';
        img.loading = 'lazy';
        wrapper.appendChild(img);

        const historyItem = AppState.history.find(h => h.id === anime.id);
        const progress = isHistory && historyItem ? 100 : 0;

        if (isHistory && progress > 0) {
            const progressBar = document.createElement('div');
            progressBar.className = 'history-progress';
            progressBar.style.width = `${Math.min(progress, 99)}%`;
            wrapper.appendChild(progressBar);
        }

        card.appendChild(wrapper);

        const title = document.createElement('div');
        title.className = 'card-title';
        title.textContent = anime.title || 'Sin título';
        card.appendChild(title);

        img.addEventListener('load', () => img.classList.add('loaded'));
        img.addEventListener('error', () => {
            img.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
            img.classList.add('loaded');
        });

        card.addEventListener('click', () => {
            DetailOverlay.open(anime.id);
        });

        return card;
    },

    renderHistorySection() {
        const container = $('continue-watching-container');
        if (AppState.history.length === 0) {
            container.innerHTML = '';
            return;
        }

        const section = document.createElement('div');
        section.className = 'home-section continue-watching-section';
        section.innerHTML = `
            <div class="home-section-header">
                <h2 class="home-section-title">Continuar Viendo</h2>
                <button class="btn-see-more">Ver todas</button>
            </div>
            <div class="row-scroll" id="history-row"></div>
        `;
        
        const row = section.querySelector('#history-row');
        AppState.history.slice(0, 10).forEach(item => {
            row.appendChild(this.buildCard(item, true));
        });
        
        section.querySelector('.btn-see-more').addEventListener('click', () => {
            Navigation.switchView('view-library');
        });
        
        container.innerHTML = '';
        container.appendChild(section);
    }
};

// ==================== HOME MANAGER ====================
const HomeManager = {
    async initializeSections(forceRefresh = false) {
        const content = $('home-content');
        if (forceRefresh) {
            content.innerHTML = '';
            AppState.homeSections.clear();
            AppState.homeInitialized = false;
            AppState.seenAnimeIds.clear();
            API.requestCache.clear();
            
            const { topGenres } = Recommendations.getTopSignals();
            const recCont = $('recommendations-container');
            if (topGenres.length > 0 && recCont) {
                const recConfig = { id: 'for_you', title: 'Recomendado Para Ti', type: 'genre', endpoint: `genre/${topGenres[0]}` };
                recCont.innerHTML = '';
                const sec = this.createSectionElement(recConfig);
                recCont.appendChild(sec);
                AppState.homeSections.set(recConfig.id, { config: recConfig, element: sec, loaded: false, data: [] });
            }
        }

        if (AppState.homeInitialized) return;
        
        for (const config of SECTIONS_CONFIG) {
            const section = this.createSectionElement(config);
            content.appendChild(section);
            AppState.homeSections.set(config.id, {
                config,
                element: section,
                loaded: false,
                data: [],
                displayedCount: 0
            });
            AppState.sectionPageCache.set(config.id, forceRefresh ? Math.floor(Math.random() * 3) + 1 : 1);
        }
        
        AppState.homeInitialized = true;
        this.setupIntersectionObserver();
        await this.loadInitialSections(forceRefresh);
    },

    async forceRefresh() {
        showToast('Actualizando catálogo y recomendaciones...');
        const loader = $('home-loader');
        if (loader) loader.style.display = 'flex';
        
        // Limpiar caches y forzar nueva sesión
        API.clearCaches();
        localStorage.removeItem(Recommendations.sessionKey);
        
        // Esperar a que se carguen los nuevos datos
        await this.initializeSections(true);
        
        // Renderizar personalizadas con datos nuevos
        await delay(300);
        this.renderPersonalizedSection();
        
        if (loader) loader.style.display = 'none';
    },

    createSectionElement(config) {
        const section = document.createElement('div');
        section.className = 'home-section';
        section.id = `section-${config.id}`;
        section.innerHTML = `
            <div class="home-section-header">
                <h2 class="home-section-title">${config.title}</h2>
                <button class="btn-see-more">Ver más</button>
            </div>
            <div class="row-scroll" id="row-${config.id}"></div>
        `;
        
        const btn = section.querySelector('.btn-see-more');
        btn.addEventListener('click', () => {
            CategoryManager.open(config);
        });
        
        return section;
    },

    setupIntersectionObserver() {
        const rootEl = $('home-scroll');
        const sentinel = $('home-sentinel');

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting && !AppState.homeLoading) {
                    this.loadNextSections();
                }
            });
        }, { 
            root: rootEl,
            rootMargin: '300px 0px 300px 0px'
        });

        if (sentinel) {
            observer.observe(sentinel);
        }
    },

    // AQUI SE APLICÓ EL FIX PARA EL LOADER INFINITO
    async loadInitialSections(nocache = false) {
        const unloaded = Array.from(AppState.homeSections.values())
            .filter(s => !s.loaded)
            .slice(0, 3);
        
        if (unloaded.length === 0) {
            return;
        }
        
        AppState.homeLoading = true;
        const promises = unloaded.map(section => this.loadSection(section.config.id, nocache));
        await Promise.allSettled(promises);
        AppState.homeLoading = false;
    },

    // AQUI SE APLICÓ EL FIX PARA EL LOADER INFINITO
    async loadNextSections() {
        const unloaded = Array.from(AppState.homeSections.values())
            .filter(s => !s.loaded);
        
        if (unloaded.length === 0) {
            return;
        }
        
        AppState.homeLoading = true;
        const batchSize = 2;
        const batch = unloaded.slice(0, batchSize);
        const promises = batch.map(section => this.loadSection(section.config.id));
        
        await Promise.allSettled(promises);
        AppState.homeLoading = false;
    },

    async loadSection(sectionId, nocache = false) {
        const section = AppState.homeSections.get(sectionId);
        if (!section) return;

        if (AppState.sectionsLoading.has(sectionId)) return;
        AppState.sectionsLoading.add(sectionId);

        try {
            const { config } = section;
            let data;
            
            if (config.type === 'latest') {
                const page = AppState.sectionPageCache.get(sectionId) || 1;
                data = await API.getLatest(page, nocache);
                AppState.sectionPageCache.set(sectionId, (page % 5) + 1);
            } else if (config.type === 'trending') {
                data = await API.getTrending(nocache);
            } else if (config.type === 'genre') {
                const genre = config.endpoint.split('/')[1];
                const page = AppState.sectionPageCache.get(sectionId) || 1;
                data = await API.getGenre(genre, page, nocache);
                AppState.sectionPageCache.set(sectionId, (page % 3) + 1);
            }

            section.loaded = true;

            if (data && data.success && data.data && data.data.length > 0) {
                let displayData = nocache ? shuffleArray([...data.data]) : data.data;
                
                section.data = displayData;
                const row = $(`row-${sectionId}`);
                if (row) {
                    row.innerHTML = '';
                    const filteredItems = [];
                    for (const item of displayData) {
                        if (!AppState.seenAnimeIds.has(item.id) && filteredItems.length < 15) {
                            AppState.seenAnimeIds.add(item.id);
                            filteredItems.push(item);
                        }
                    }
                    
                    filteredItems.forEach((item, idx) => {
                        const card = UIBuilder.buildCard(item);
                        card.style.animationDelay = `${idx * 0.05}s`;
                        row.appendChild(card);
                    });
                }
            } else {
                if (section.element) section.element.style.display = 'none';
            }
        } catch (err) {
            console.error('[HomeManager] Error cargando sección:', err);
            section.loaded = true;
            if (section.element) section.element.style.display = 'none';
        } finally {
            AppState.sectionsLoading.delete(sectionId);
        }
    }
};

// ==================== CATEGORY MANAGER ====================
const CategoryManager = {
    open(config) {
        AppState.categoryType = config.type;
        AppState.categoryGenre = config.type === 'genre' ? config.endpoint.split('/')[1] : null;
        AppState.categoryPage = 1;
        AppState.categoryHasMore = true;

        $('category-title').textContent = config.title;
        $('category-grid').innerHTML = '';
        
        Navigation.switchView('view-category');
        this.loadMore();
    },

    async loadMore() {
        if (AppState.categoryLoading || !AppState.categoryHasMore) return;
        
        AppState.categoryLoading = true;
        const loader = $('category-loader');
        if (loader) loader.style.display = 'flex';

        try {
            let data;
            if (AppState.categoryType === 'latest') {
                data = await API.getLatest(AppState.categoryPage);
            } else if (AppState.categoryType === 'trending') {
                data = await API.getTrending();
                AppState.categoryHasMore = false;
            } else if (AppState.categoryType === 'genre' && AppState.categoryGenre) {
                data = await API.getGenre(AppState.categoryGenre, AppState.categoryPage);
            } else {
                data = { success: false, data: [] };
            }

            if (data.success && data.data && data.data.length > 0) {
                const grid = $('category-grid');
                data.data.forEach((item, idx) => {
                    const card = UIBuilder.buildCard(item);
                    card.style.animationDelay = `${(idx % 20) * 0.05}s`;
                    grid.appendChild(card);
                });
                
                AppState.categoryPage++;
                if (data.data.length < 20) {
                    AppState.categoryHasMore = false;
                }
            } else {
                AppState.categoryHasMore = false;
            }
        } catch (err) {
            console.error('[CategoryManager] Error cargando más:', err);
            showToast('Error al cargar más');
            AppState.categoryHasMore = false;
        } finally {
            AppState.categoryLoading = false;
            if (loader) {
                loader.style.display = AppState.categoryHasMore ? 'flex' : 'none';
            }
        }
    },

    setupScroll() {
        const scrollEl = $('category-scroll');
        const sentinel = $('category-sentinel');
        
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting && !AppState.categoryLoading && AppState.categoryHasMore) {
                    this.loadMore();
                }
            });
        }, { root: scrollEl, rootMargin: '0px 0px 300px 0px' });
        
        if (sentinel) {
            observer.observe(sentinel);
        }
    }
};

// ==================== DETAIL OVERLAY ====================
const DetailOverlay = {
    resetVisuals() {
        const titleEl = $('detail-title');
        const coverEl = $('detail-cover');
        const backdropEl = $('detail-backdrop');
        const synopsisEl = $('detail-synopsis');
        const statusEl = $('detail-status');
        const epCountEl = $('detail-ep-count');
        const genresCont = $('detail-genres');
        const episodesCont = $('detail-episodes');

        if(titleEl) titleEl.textContent = 'Cargando...';
        if(coverEl) coverEl.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
        if(backdropEl) backdropEl.style.backgroundImage = 'none';
        if(synopsisEl) synopsisEl.textContent = '';
        if(statusEl) statusEl.textContent = '...';
        if(epCountEl) epCountEl.textContent = '0';
        if(genresCont) genresCont.innerHTML = '';
        if(episodesCont) episodesCont.innerHTML = '';
        
        const btn = $('btn-library');
        if(btn) btn.classList.remove('active');
    },

    async open(animeId) {
        const overlay = $('overlay-detail');
        overlay.classList.add('active');
        
        this.resetVisuals();

        const loading = $('detail-loading');
        const loaded = $('detail-loaded');
        if (loading) loading.style.display = 'flex';
        if (loaded) loaded.style.opacity = '0';

        try {
            const data = await API.getInfo(animeId);
            if (!data.success || !data.data) {
                throw new Error(data.error || 'No se encontró el anime');
            }

            const anime = data.data;
            AppState.currentAnime = anime;
            
            // Registrar interacción con el anime para recomendaciones
            Recommendations.registerAnime(anime, 1.0);
            
            if(anime.genres) Recommendations.updateWeights(anime.genres, anime);

            if (loading) loading.style.display = 'none';
            await delay(50);
            if (loaded) loaded.style.opacity = '1';
            this.render(anime);
        } catch (err) {
            console.error('[DetailOverlay] Error:', err);
            showToast('Anime no encontrado');
            this.close();
        }
    },

    render(anime) {
        const titleEl = $('detail-title');
        const coverEl = $('detail-cover');
        const backdropEl = $('detail-backdrop');
        const synopsisEl = $('detail-synopsis');
        const statusEl = $('detail-status');
        const epCountEl = $('detail-ep-count');

        if (titleEl) titleEl.textContent = anime.title;
        if (coverEl) {
            coverEl.src = anime.cover || 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
            coverEl.onerror = function() {
                this.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
            };
        }
        if (backdropEl) {
            backdropEl.style.backgroundImage = `url(${anime.cover || ''})`;
        }
        if (synopsisEl) synopsisEl.textContent = anime.synopsis || 'Sin sinopsis disponible';
        if (statusEl) statusEl.textContent = anime.status || 'Desconocido';
        if (epCountEl) epCountEl.textContent = anime.episodes?.length || 0;

        const genresCont = $('detail-genres');
        if (genresCont) {
            genresCont.innerHTML = '';
            (anime.genres || []).forEach((g, idx) => {
                const span = document.createElement('span');
                span.textContent = g;
                span.style.animationDelay = `${idx * 0.05}s`;
                genresCont.appendChild(span);
            });
        }

        const episodesCont = $('detail-episodes');
        if (episodesCont) {
            episodesCont.innerHTML = '';
            
            if (!anime.episodes || anime.episodes.length === 0) {
                const msg = document.createElement('div');
                msg.className = 'empty-state-premium';
                msg.textContent = 'No se encontraron episodios.';
                episodesCont.appendChild(msg);
            } else {
                anime.episodes.forEach((ep, idx) => {
                    const row = document.createElement('div');
                    row.className = 'ep-row';
                    row.style.animationDelay = `${idx * 0.02}s`;
                    
                    const historyItem = AppState.history.find(h => h.id === anime.id);
                    const isWatched = historyItem && historyItem.lastEp === ep.number;
                    
                    row.innerHTML = `
                        <span class="ep-number">Episodio ${ep.number}${isWatched ? ' ✓' : ''}</span>
                        <span class="ep-play">▶</span>
                    `;
                    row.addEventListener('click', () => {
                        PlayerOverlay.open(ep.number);
                    });
                    episodesCont.appendChild(row);
                });
            }
        }

        this.updateLibraryBtn();
    },

    updateLibraryBtn() {
        const btn = $('btn-library');
        if(!AppState.currentAnime || !btn) return;
        const isSaved = AppState.library.some(a => a.id === AppState.currentAnime.id);
        
        if (isSaved) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    },

    close() {
        const overlay = $('overlay-detail');
        if (overlay) overlay.classList.remove('active');
    }
};

// ==================== PLAYER OVERLAY ====================
const PlayerOverlay = {
    retryCount: 0,
    maxRetries: 3,
    
    async open(epNumber) {
        if (!AppState.currentAnime) return;

        const token = (AppState.playerRequestId || 0) + 1;
        AppState.playerRequestId = token;
        AppState.currentEpisode = epNumber;
        AppState.currentServerIndex = 0;
        this.retryCount = 0;

        const overlay = $('overlay-player');
        if (overlay) overlay.classList.add('active');

        const titleEl = $('player-title');
        const episodeEl = $('player-episode-info');
        const iframeEl = $('player-iframe');

        if (titleEl) titleEl.textContent = AppState.currentAnime.title || 'Sin título';
        if (episodeEl) episodeEl.textContent = `Episodio ${epNumber}`;
        if (iframeEl) iframeEl.src = '';

        const loader = $('player-loader');
        if (loader) loader.style.display = 'flex';

        const error = $('player-error');
        if (error) error.classList.add('hidden');

        const serverSelector = $('server-selector');
        if (serverSelector) serverSelector.innerHTML = '';

        try {
            const data = await API.getVideo(AppState.currentAnime.id, epNumber);
            if (token !== AppState.playerRequestId) return;

            if (!data.success || !data.data || !data.data.servers || data.data.servers.length === 0) {
                throw new Error('No se encontraron servidores');
            }

            AppState.currentServers = data.data.servers;
            this.renderServers();
            this.loadServer(0);
            this.updateNavigation();
        } catch (err) {
            if (token !== AppState.playerRequestId) return;
            console.error('[PlayerOverlay] Error:', err);
            this.showError('No se pudo cargar el video');
            this.updateNavigation();
        }
    },

    renderServers() {
        const selector = $('server-selector');
        if (!selector) return;
        
        const newSelector = selector.cloneNode(false);
        selector.parentNode.replaceChild(newSelector, selector);

        AppState.currentServers.forEach((server, idx) => {
            const opt = document.createElement('option');
            opt.value = idx;
            opt.textContent = server.name || `Servidor ${idx + 1}`;
            newSelector.appendChild(opt);
        });

        newSelector.addEventListener('change', (e) => {
            this.loadServer(parseInt(e.target.value, 10));
        });
    },

    loadServer(index) {
        const server = AppState.currentServers[index];
        if (!server) return;

        AppState.currentServerIndex = index;
        const loader = $('player-loader');
        const error = $('player-error');

        if (loader) loader.style.display = 'none';
        if (error) error.classList.add('hidden');

        const iframe = $('player-iframe');
        if (!iframe) return;

        const token = AppState.playerRequestId || 0;
        let loadTimer = null;

        const cleanup = () => {
            if (loadTimer) {
                clearTimeout(loadTimer);
                loadTimer = null;
            }
        };

        iframe.onload = () => {
            if (token !== AppState.playerRequestId) return;
            cleanup();
            if (AppState.currentAnime && AppState.currentEpisode) {
                this.saveToHistory(AppState.currentAnime, AppState.currentEpisode);
            }
        };

        iframe.onerror = () => {
            if (token !== AppState.playerRequestId) return;
            cleanup();
            if (this.retryCount < this.maxRetries - 1) {
                this.retryCount++;
                setTimeout(() => {
                    this.loadServer(AppState.currentServerIndex);
                }, 1000);
            } else {
                this.showError('Servidor no disponible. Intenta otro.');
            }
        };

        loadTimer = setTimeout(() => {
            if (token !== AppState.playerRequestId) return;
            if (this.retryCount < this.maxRetries - 1) {
                this.retryCount++;
                const nextIndex = (AppState.currentServerIndex + 1) % AppState.currentServers.length;
                this.loadServer(nextIndex);
            } else {
                this.showError('El servidor no respondió. Intenta otro.');
            }
        }, 12000);

        iframe.src = server.url;
    },

    showError(message) {
        const loader = $('player-loader');
        const error = $('player-error');
        
        if (loader) loader.style.display = 'none';
        if (error) {
            error.classList.remove('hidden');
            const msgEl = error.querySelector('.error-message');
            if (msgEl) msgEl.textContent = message;
        }
        
        const btnRetry = $('btn-retry');
        if (btnRetry) {
            btnRetry.onclick = () => {
                this.retryCount = 0;
                this.loadServer(AppState.currentServerIndex);
            };
        }
    },

    updateNavigation() {
        const eps = AppState.currentAnime?.episodes || [];
        const canGoPrev = eps.some(e => e.number === AppState.currentEpisode - 1);
        const canGoNext = eps.some(e => e.number === AppState.currentEpisode + 1);

        const btnPrev = $('btn-prev-ep');
        const btnNext = $('btn-next-ep');
        
        if (btnPrev) {
            btnPrev.disabled = !canGoPrev;
            btnPrev.onclick = () => {
                if (canGoPrev) this.open(AppState.currentEpisode - 1);
            };
        }
        if (btnNext) {
            btnNext.disabled = !canGoNext;
            btnNext.onclick = () => {
                if (canGoNext) this.open(AppState.currentEpisode + 1);
            };
        }
    },

    saveToHistory(anime, episode) {
        const now = Date.now();
        const existingIndex = AppState.history.findIndex(h => h.id === anime.id);
        const existing = existingIndex > -1 ? AppState.history[existingIndex] : null;
        const watchedEps = new Set(existing && Array.isArray(existing.watchedEps) ? existing.watchedEps : []);
        watchedEps.add(episode);

        const historyItem = {
            id: anime.id,
            title: anime.title,
            cover: anime.cover,
            lastEp: episode,
            watchedEps: Array.from(watchedEps).sort((a, b) => a - b),
            progress: 100,
            duration: 100,
            timestamp: now,
            lastUpdated: now
        };

        if (existingIndex > -1) {
            AppState.history.splice(existingIndex, 1);
        }
        
        AppState.history.unshift(historyItem);
        AppState.history = AppState.history.slice(0, 100);
        
        localStorage.setItem('anime_history', JSON.stringify(AppState.history));
        UIBuilder.renderHistorySection();
    },

    close() {
        const overlay = $('overlay-player');
        const iframe = $('player-iframe');
        
        if (overlay) overlay.classList.remove('active');
        if (iframe) iframe.src = '';
    }
};

// ==================== SEARCH ====================
const Search = {
    setup() {
        const input = $('search-input');
        const clear = $('search-clear');
        const message = $('search-message');
        const grid = $('search-grid');

        if (!input) return;

        input.addEventListener('input', debounce((e) => {
            const q = e.target.value.trim();
            
            if (clear) clear.classList.toggle('hidden', q.length === 0);

            if (q.length < 3) {
                if (grid) grid.innerHTML = '';
                if (message) message.style.display = 'flex';
                return;
            }

            this.execute(q);
        }, 400));

        if (clear) {
            clear.addEventListener('click', () => {
                input.value = '';
                if (grid) grid.innerHTML = '';
                clear.classList.add('hidden');
                if (message) message.style.display = 'flex';
            });
        }
    },

    async execute(query) {
        const message = $('search-message');
        const grid = $('search-grid');
        const loader = $('search-loader');

        if (message) message.style.display = 'none';
        if (loader) loader.classList.remove('hidden');

        try {
            const data = await API.search(query);
            
            // Registrar búsqueda en X.EY
            XEy.recordSearch(query, data.data?.length || 0);
            
            if (!data.success || !data.data || data.data.length === 0) {
                if (message) {
                    message.innerHTML = '<svg viewBox="0 0 24 24" width="48" height="48" stroke="currentColor" stroke-width="1.5" fill="none" style="opacity:0.5"><circle cx="11" cy="11" r="8"></circle><path d="M21 21l-4.35-4.35"></path></svg><p>No se encontraron resultados</p>';
                    message.style.display = 'flex';
                }
                if (grid) grid.innerHTML = '';
            } else {
                if (grid) {
                    grid.innerHTML = '';
                    data.data.forEach((item, idx) => {
                        const card = UIBuilder.buildCard(item);
                        card.style.animationDelay = `${idx * 0.05}s`;
                        
                        // Registrar si se selecciona
                        card.addEventListener('click', () => {
                            XEy.recordSearch(query, data.data.length, item.id);
                        });
                        
                        grid.appendChild(card);
                    });
                }
            }
        } catch (err) {
            console.error('[Search] Error:', err);
            if (message) {
                message.innerHTML = '<svg viewBox="0 0 24 24" width="48" height="48" stroke="currentColor" stroke-width="1.5" fill="none" style="opacity:0.5"><circle cx="11" cy="11" r="8"></circle><path d="M21 21l-4.35-4.35"></path></svg><p>Error al buscar</p>';
                message.style.display = 'flex';
            }
        } finally {
            if (loader) loader.classList.add('hidden');
        }
    }
};

// ==================== LIBRARY ====================
const Library = {
    render() {
        const grid = $('library-grid');
        const empty = $('library-empty');

        if (!grid) return;

        grid.innerHTML = '';
        
        if (AppState.library.length === 0) {
            if (empty) empty.style.display = 'flex';
        } else {
            if (empty) empty.style.display = 'none';
            AppState.library.forEach((item, idx) => {
                const card = UIBuilder.buildCard(item);
                card.style.animationDelay = `${idx * 0.05}s`;
                grid.appendChild(card);
            });
        }
    },

    toggle(anime) {
        const idx = AppState.library.findIndex(a => a.id === anime.id);
        
        if (idx > -1) {
            AppState.library.splice(idx, 1);
            showToast('Eliminado de la biblioteca');
        } else {
            AppState.library.push({
                id: anime.id,
                title: anime.title,
                cover: anime.cover
            });
            showToast('Guardado en la biblioteca');
        }

        if(anime.genres) Recommendations.updateWeights(anime.genres);
        localStorage.setItem('anime_library', JSON.stringify(AppState.library));
        DetailOverlay.updateLibraryBtn();
        this.render();
    },

    setup() {
        const btn = $('btn-library');
        if (btn) {
            btn.addEventListener('click', () => {
                if (AppState.currentAnime) {
                    this.toggle(AppState.currentAnime);
                }
            });
        }
    }
};

// ==================== NAVIGATION ====================
const Navigation = {
    setup() {
        document.querySelectorAll('.nav-item-premium').forEach(btn => {
            btn.addEventListener('click', () => {
                const target = btn.dataset.target;
                if (target === 'view-home' && $('view-home').classList.contains('active')) {
                    HomeManager.forceRefresh();
                    return;
                }
                this.switchView(target);
            });
        });

        const btnBackCat = $('btn-back-category');
        if (btnBackCat) {
            btnBackCat.addEventListener('click', () => {
                this.switchView('view-home');
            });
        }

        const btnCloseDetail = $('btn-close-detail');
        if (btnCloseDetail) {
            btnCloseDetail.addEventListener('click', () => {
                DetailOverlay.close();
            });
        }

        const btnClosePlayer = $('btn-close-player');
        if (btnClosePlayer) {
            btnClosePlayer.addEventListener('click', () => {
                PlayerOverlay.close();
            });
        }
    },

    switchView(target) {
        document.querySelectorAll('.view').forEach(v => {
            v.classList.remove('active');
        });
        const targetEl = $(target);
        if (targetEl) targetEl.classList.add('active');

        document.querySelectorAll('.nav-item-premium').forEach(n => {
            n.classList.remove('active');
        });
        const navBtn = document.querySelector(`[data-target="${target}"]`);
        if (navBtn) navBtn.classList.add('active');
    }
};

// ==================== SETTINGS ====================
const Settings = {
    setup() {
        const btn = $('btn-clear-cache');
        if (btn) {
            btn.addEventListener('click', () => {
                if (confirm('¿Limpiar todos los datos locales? (Biblioteca, Historial y Recomendaciones)')) {
                    localStorage.clear();
                    location.reload();
                }
            });
        }
        
        const btnResetReco = $('btn-reset-recommendations');
        if (btnResetReco) {
            btnResetReco.addEventListener('click', () => {
                if (confirm('¿Reiniciar perfil de recomendaciones? Esto borrará tu historial de preferencias.')) {
                    Recommendations.resetProfile();
                    HomeManager.forceRefresh();
                }
            });
        }
    }
};

// ==================== SMART ENHANCEMENTS ====================
const normalizeText = (value = '') => String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const uniqueById = (items = []) => {
    const seen = new Set();
    return items.filter(item => {
        const id = item && item.id ? String(item.id) : '';
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
    });
};

const hashString = (input = '') => {
    let hash = 0;
    const str = String(input);
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
};

const buildAnimeTokens = (anime = {}) => {
    const pieces = [
        anime.title,
        anime.synopsis,
        anime.status,
        anime.type,
        ...(anime.genres || []),
        ...(anime.tags || [])
    ].filter(Boolean);

    const tokens = new Set();
    pieces.forEach(piece => {
        normalizeText(piece).split(' ').forEach(word => {
            if (word.length >= 3 && !['anime', 'episodio', 'capitulo', 'online', 'sub', 'dub'].includes(word)) {
                tokens.add(word);
            }
        });
    });
    return Array.from(tokens).slice(0, 40);
};

const safeNumber = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
};

Recommendations.profileKey = 'anime_reco_profile_v2';
Recommendations._loadProfile = function () {
    try {
        const profile = JSON.parse(localStorage.getItem(this.profileKey) || '{}');
        return {
            genres: profile.genres || {},
            tokens: profile.tokens || {},
            types: profile.types || {},
            statuses: profile.statuses || {},
            favorites: profile.favorites || {},
            views: profile.views || {},
            lastUpdated: profile.lastUpdated || Date.now()
        };
    } catch {
        return { genres: {}, tokens: {}, types: {}, statuses: {}, favorites: {}, views: {}, lastUpdated: Date.now() };
    }
};
Recommendations._saveProfile = function (profile) {
    profile.lastUpdated = Date.now();
    localStorage.setItem(this.profileKey, JSON.stringify(profile));
};
Recommendations._touchBucket = function (bucket, key, weight = 1) {
    if (!key) return;
    bucket[key] = (bucket[key] || 0) + weight;
};
Recommendations.registerAnime = function (anime, weight = 1) {
    if (!anime || !anime.id) return;
    const profile = this._loadProfile();
    (anime.genres || []).forEach(genre => this._touchBucket(profile.genres, normalizeText(genre), weight * 2.2));
    (anime.type ? [anime.type] : []).forEach(type => this._touchBucket(profile.types, normalizeText(type), weight * 0.7));
    (anime.status ? [anime.status] : []).forEach(status => this._touchBucket(profile.statuses, normalizeText(status), weight * 0.5));
    buildAnimeTokens(anime).forEach(token => this._touchBucket(profile.tokens, token, weight * 0.15));
    this._touchBucket(profile.views, anime.id, weight);
    this._saveProfile(profile);
};
Recommendations.registerFavorite = function (anime, isFavorite = true) {
    if (!anime || !anime.id) return;
    const profile = this._loadProfile();
    const weight = isFavorite ? 3.4 : 1.2;
    (anime.genres || []).forEach(genre => this._touchBucket(profile.genres, normalizeText(genre), weight * 2.8));
    buildAnimeTokens(anime).forEach(token => this._touchBucket(profile.tokens, token, weight * 0.3));
    this._touchBucket(profile.favorites, anime.id, isFavorite ? 1 : -1);
    this._saveProfile(profile);
};
Recommendations.updateWeights = function (genres, anime = null, weight = 1) {
    if (!Array.isArray(genres) || genres.length === 0) return;
    const profile = this._loadProfile();
    genres.forEach(genre => this._touchBucket(profile.genres, normalizeText(genre), weight * 1.8));
    if (anime) {
        this.registerAnime(anime, weight * 0.8);
    } else {
        this._saveProfile(profile);
    }
};
Recommendations.getTopSignals = function () {
    const profile = this._loadProfile();
    const topGenres = Object.entries(profile.genres).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
    const topTokens = Object.entries(profile.tokens).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
    return { topGenres, topTokens };
};
Recommendations.getProfile = function () {
    return this._loadProfile();
};
Recommendations.scoreAnime = function (anime) {
    if (!anime || !anime.id) return 0;
    const profile = this._loadProfile();
    const titleTokens = buildAnimeTokens(anime);
    const normalizedGenres = (anime.genres || []).map(genre => normalizeText(genre));
    const normalizedType = normalizeText(anime.type || '');
    const normalizedStatus = normalizeText(anime.status || '');
    let score = 0;

    normalizedGenres.forEach(genre => {
        score += profile.genres[genre] ? profile.genres[genre] * 2.0 : 0;
    });

    titleTokens.forEach(token => {
        score += profile.tokens[token] ? profile.tokens[token] * 0.55 : 0;
    });

    if (normalizedType && profile.types[normalizedType]) {
        score += profile.types[normalizedType] * 0.9;
    }

    if (normalizedStatus && profile.statuses[normalizedStatus]) {
        score += profile.statuses[normalizedStatus] * 0.5;
    }

    if (AppState.library.some(item => item.id === anime.id)) {
        score += 4.5;
    }

    const historyItem = AppState.history.find(item => item.id === anime.id);
    if (historyItem) {
        const recencyBoost = Math.max(0, 1 - ((Date.now() - (historyItem.lastUpdated || historyItem.timestamp || 0)) / (1000 * 60 * 60 * 24 * 14)));
        score += 2.5 + recencyBoost * 2;
    }

    const lastEpisode = safeNumber(anime.lastEpisode, 0);
    if (lastEpisode > 0) {
        score += Math.min(lastEpisode / 100, 0.8);
    }

    return score;
};
Recommendations.rankItems = function (items = []) {
    return uniqueById(items)
        .map(item => ({ ...item, __score: this.scoreAnime(item), __shuffle: hashString(item.id || item.title || '') }))
        .sort((a, b) => {
            if (b.__score !== a.__score) return b.__score - a.__score;
            return a.__shuffle - b.__shuffle;
        })
        .map(({ __score, __shuffle, ...item }) => item);
};

const buildRequestKey = (endpoint, params = {}) => {
    const clean = {};
    Object.entries(params || {}).forEach(([k, v]) => {
        if (v === undefined || v === null || v === false || v === '') return;
        clean[k] = v;
    });
    const qs = new URLSearchParams(clean).toString();
    return `${API_BASE}/${endpoint}${qs ? '?' + qs : ''}`;
};

API.pendingRequests = new Map();
API.fetch = async function (endpoint, params = {}) {
    const clean = {};
    Object.entries(params || {}).forEach(([k, v]) => {
        if (v === undefined || v === null || v === false || v === '') return;
        clean[k] = v;
    });
    const requestKey = buildRequestKey(endpoint, clean);
    const bypass = clean.nocache === true || clean.nocache === 'true';

    try {
        if (!bypass && this.requestCache.has(requestKey)) {
            return this.requestCache.get(requestKey);
        }
        if (this.pendingRequests.has(requestKey)) {
            return this.pendingRequests.get(requestKey);
        }

        const requestPromise = (async () => {
            const url = bypass ? `${requestKey}${requestKey.includes('?') ? '&' : '?'}_=${Date.now()}` : requestKey;
            const response = await fetch(url, { headers: { 'Accept': 'application/json' }, cache: 'no-store' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (!bypass) {
                this.requestCache.set(requestKey, data);
                setTimeout(() => this.requestCache.delete(requestKey), 3 * 60 * 1000);
            }
            return data;
        })();

        this.pendingRequests.set(requestKey, requestPromise);
        return await requestPromise;
    } catch (err) {
        console.error('[API Error]', err);
        return { success: false, error: err.message, data: null };
    } finally {
        this.pendingRequests.delete(requestKey);
    }
};
API.clearCaches = function () {
    this.requestCache.clear();
    this.pendingRequests.clear();
};

HomeManager.getAllLoadedItems = function () {
    const items = [];
    AppState.homeSections.forEach(section => {
        if (Array.isArray(section.data)) items.push(...section.data);
    });
    if (items.length === 0) {
        items.push(...AppState.history, ...AppState.library);
    }
    return uniqueById(items);
};

HomeManager.renderPersonalizedSection = function (forceNewSeed = true) {
    const container = $('recommendations-container');
    if (!container) return;
    
    const { topGenres, topTokens, topYears } = Recommendations.getTopSignals();
    const candidates = this.getAllLoadedItems();
    const ranked = Recommendations.rankItems(candidates, 'personalized', forceNewSeed).slice(0, 15);
    
    // Usar datos de X.VITALS para mostrar estado
    const vitals = XVitals._loadVitals();
    const aliveContent = Object.values(vitals).filter(v => v.engagement >= 70).length;

    if (ranked.length === 0) {
        container.innerHTML = '';
        return;
    }

    const section = document.createElement('div');
    section.className = 'home-section recommendation-panel';
    section.innerHTML = `
        <div class="home-section-header">
            <h2 class="home-section-title">Recomendado Para Ti</h2>
            <button class="btn-see-more" id="btn-refresh-home">Refrescar</button>
        </div>
        <div class="recommendation-meta">
            <span class="mini-pill">${topGenres[0] ? `Género: ${topGenres[0]}` : 'Basado en tu actividad'}</span>
            <span class="mini-pill">${AppState.history.length} vistos</span>
            <span class="mini-pill">${AppState.library.length} favoritos</span>
            <span class="mini-pill">🔄 Explotación: ${XAgente.exploitationThreshold}% | Exploración: ${XAgente.explorationThreshold}%</span>
            <span class="mini-pill" title="Contenido activo/vitalidad">📊 ${aliveContent} activos</span>
        </div>
        <div class="row-scroll" id="personalized-row"></div>
    `;

    const row = section.querySelector('#personalized-row');
    ranked.forEach((item, idx) => {
        const card = UIBuilder.buildCard(item);
        card.setAttribute('data-anime-id', XAgente._generateUniqueId(item));
        card.style.animationDelay = `${idx * 0.04}s`;
        
        // Registrar interacción cuando se hace clic
        card.addEventListener('click', function() {
            const animeId = this.getAttribute('data-anime-id');
            XAgente._recordInteraction(item);
        });
        
        row.appendChild(card);
    });

    section.querySelector('#btn-refresh-home').addEventListener('click', async () => {
        await HomeManager.forceRefresh();
    });

    container.innerHTML = '';
    container.appendChild(section);
};

HomeManager.bindFilterChips = function () {
    document.querySelectorAll('[data-home-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('[data-home-filter]').forEach(node => node.classList.remove('active'));
            btn.classList.add('active');
            const filter = btn.dataset.homeFilter;

            if (filter === 'recommended') {
                const rec = $('recommendations-container');
                if (rec) rec.scrollIntoView({ behavior: 'smooth', block: 'start' });
                this.renderPersonalizedSection();
                return;
            }

            const targetSection = filter ? document.getElementById(`section-${filter}`) : null;
            if (targetSection) {
                targetSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } else {
                HomeManager.forceRefresh();
            }
        });
    });
};

const originalLibraryToggle = Library.toggle.bind(Library);
Library.toggle = function (anime) {
    const idx = AppState.library.findIndex(a => a.id === anime.id);
    originalLibraryToggle(anime);
    Recommendations.registerFavorite(anime, idx === -1);
};

PlayerOverlay.close = function () {
    AppState.playerRequestId = (AppState.playerRequestId || 0) + 1;
    const overlay = $('overlay-player');
    const iframe = $('player-iframe');
    if (overlay) overlay.classList.remove('active');
    if (iframe) iframe.src = '';
};

// ==================== APP INIT ====================
const App = {
    async init() {
        try {
            Navigation.setup();
            Library.setup();
            Library.render();
            Search.setup();
            Settings.setup();
            CategoryManager.setupScroll();
            
            if (HomeManager.bindFilterChips) HomeManager.bindFilterChips();
            
            UIBuilder.renderHistorySection();
            await HomeManager.initializeSections(false);
            
            HomeManager.renderPersonalizedSection();
            
            // Inicializar sistemas de IA
            XVitals.analyzeAll();
            XVitals.startMonitoring();
            XAgente.startAgent();
            
            console.log('[AnimeSAO Pro] ✓ App initialized');
            console.log('[AnimeSAO Pro] ✓ Version: 3.2.0 Premium');
            console.log('[X.AGENTE] ✓ Motor central activo');
            console.log('[X.EY] ✓ Motor de búsqueda activo');
            console.log('[X.VITALS] ✓ Monitor de vitalidad activo');
        } catch (err) {
            console.error('[App] Error en inicialización:', err);
            showToast('Error al inicializar');
        }
    }
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        App.init();
    });
} else {
    App.init();
}

window.addEventListener('beforeunload', () => {
    localStorage.setItem('anime_library', JSON.stringify(AppState.library));
    localStorage.setItem('anime_history', JSON.stringify(AppState.history));
    XAgente.stopAgent();
    XVitals.stopMonitoring();
});
