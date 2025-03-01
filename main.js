// Configuration settings for Recipe Master
const config = {
    API_KEY: '528d47657a174064992e9b1bc685695a',
    BASE_URL: 'https://api.spoonacular.com/recipes',
    CACHE_DURATION: 24 * 60 * 60 * 1000, // 24 hours in milliseconds
    MAX_REQUESTS_PER_DAY: 150,
    defaultParams: {
        number: 12,
        addRecipeInformation: true,
        fillIngredients: true
    },
    RATE_LIMIT_MS: 1000,
    BATCH_SIZE: 24,
    MIN_RATING: 4.5
};

const RECIPE_PREFERENCES = {
    defaultDietaryBalance: {
        vegetarian: 0.3, // Limit vegetarian recipes to 30% unless filtered
        regular: 0.7
    }
};

const BASE_URL = 'https://api.spoonacular.com/recipes';
const API_KEY = '528d47657a174064992e9b1bc685695a';

class RequestQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.lastRequestTime = 0;
        this.minRequestInterval = 100; // 100ms between requests
    }

    async add(request) {
        return new Promise((resolve, reject) => {
            this.queue.push({ request, resolve, reject });
            this.process();
        });
    }

    async process() {
        if (this.processing) return;
        this.processing = true;

        while (this.queue.length > 0) {
            const timeSinceLastRequest = Date.now() - this.lastRequestTime;
            if (timeSinceLastRequest < this.minRequestInterval) {
                await new Promise(r => setTimeout(r, this.minRequestInterval - timeSinceLastRequest));
            }

            const { request, resolve, reject } = this.queue.shift();
            try {
                const response = await this.executeRequest(request);
                resolve(response);
            } catch (error) {
                reject(error);
            }

            this.lastRequestTime = Date.now();
        }

        this.processing = false;
    }

    async executeRequest(request, retries = 3) {
        for (let i = 0; i < retries; i++) {
            try {
                const response = await fetch(request.url, request.options);
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                return await response.json();
            } catch (error) {
                if (i === retries - 1) throw error;
                await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i))); // Exponential backoff
            }
        }
    }
}

class CircuitBreaker {
    constructor(failureThreshold = 5, resetTimeout = 60000) {
        this.failureThreshold = failureThreshold;
        this.resetTimeout = resetTimeout;
        this.failures = 0;
        this.lastFailureTime = null;
        this.state = 'CLOSED';
    }

    async execute(operation) {
        if (this.shouldReset()) {
            this.reset();
        }

        if (this.state === 'OPEN') {
            throw new Error('Circuit breaker is OPEN');
        }

        try {
            const result = await operation();
            this.recordSuccess();
            return result;
        } catch (error) {
            this.recordFailure();
            throw error;
        }
    }

    recordSuccess() {
        this.failures = 0;
        this.state = 'CLOSED';
    }

    recordFailure() {
        this.failures++;
        this.lastFailureTime = Date.now();

        if (this.failures >= this.failureThreshold) {
            this.state = 'OPEN';
        }
    }

    shouldReset() {
        return this.state === 'OPEN' && 
               this.lastFailureTime && 
               Date.now() - this.lastFailureTime >= this.resetTimeout;
    }

    reset() {
        this.failures = 0;
        this.state = 'CLOSED';
        this.lastFailureTime = null;
    }
}

class RequestScheduler {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.rateLimit = {
            requests: 0,
            timestamp: Date.now(),
            limit: 5,
            interval: 1000
        };
    }

    async schedule(priority, operation) {
        return new Promise((resolve, reject) => {
            this.queue.push({
                priority,
                operation,
                resolve,
                reject,
                timestamp: Date.now()
            });
            
            this.queue.sort((a, b) => b.priority - a.priority);
            this.process();
        });
    }

    async process() {
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;

        while (this.queue.length > 0) {
            if (!this.canMakeRequest()) {
                await this.wait(this.getWaitTime());
                continue;
            }

            const request = this.queue.shift();
            try {
                const result = await request.operation();
                request.resolve(result);
            } catch (error) {
                request.reject(error);
            }

            this.updateRateLimit();
        }

        this.processing = false;
    }

    canMakeRequest() {
        const now = Date.now();
        if (now - this.rateLimit.timestamp > this.rateLimit.interval) {
            this.rateLimit.requests = 0;
            this.rateLimit.timestamp = now;
        }
        return this.rateLimit.requests < this.rateLimit.limit;
    }

    updateRateLimit() {
        this.rateLimit.requests++;
    }

    getWaitTime() {
        return this.rateLimit.interval - (Date.now() - this.rateLimit.timestamp);
    }

    wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

class APIClient {
    constructor(config) {
        this.config = config;
        this.cache = new Map();
        this.userSessions = new Map();
        this.circuitBreaker = new CircuitBreaker();
        this.scheduler = new RequestScheduler();
        this.retryDelays = [1000, 2000, 4000, 8000, 16000];
    }

    async request(endpoint, params = {}, userId = 'default', priority = 1) {
        const url = this.buildUrl(endpoint, params);
        const cacheKey = this.getCacheKey(url, userId);

        // Add dietary balance to params if not explicitly searching for vegetarian
        if (!params.diet && !params.vegetarian) {
            params.maxVegetarian = Math.ceil(params.number * RECIPE_PREFERENCES.defaultDietaryBalance.vegetarian);
        }

        try {
            // Check cache first
            const cachedResponse = this.getFromCache(cacheKey);
            if (cachedResponse) return cachedResponse;

            // Check user quota
            this.checkUserQuota(userId);

            // Schedule the request with priority
            const response = await this.scheduler.schedule(priority, 
                () => this.executeRequest(url, userId)
            );

            // Update cache and quota
            this.updateCache(cacheKey, response);
            this.updateUserQuota(userId);

            return response;
        } catch (error) {
            return await this.handleError(error, endpoint, params, userId, priority);
        }
    }

    async executeRequest(url, userId, retryCount = 0) {
        return await this.circuitBreaker.execute(async () => {
            const response = await fetch(url, this.getRequestOptions());
            
            if (!response.ok) {
                if (response.status === 429) { // Rate limit exceeded
                    const retryAfter = response.headers.get('Retry-After') || 5;
                    throw new Error(`Rate limit exceeded. Retry after ${retryAfter}s`);
                }
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            return await response.json();
        });
    }

    async handleError(error, endpoint, params, userId, priority) {
        console.error('API request failed:', error);

        if (error.message.includes('Rate limit exceeded')) {
            // Wait and retry with exponential backoff
            const retryDelay = this.retryDelays[Math.min(retryCount, this.retryDelays.length - 1)];
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            return this.request(endpoint, params, userId, priority);
        }

        if (error.message === 'Circuit breaker is OPEN') {
            // Use stale cache if available
            const cacheKey = this.getCacheKey(this.buildUrl(endpoint, params), userId);
            const staleData = this.getStaleCache(cacheKey);
            if (staleData) {
                console.log('Using stale cache due to circuit breaker');
                return staleData;
            }
        }

        throw error;
    }

    getStaleCache(key) {
        const cached = this.cache.get(key);
        if (cached) {
            cached.isStale = true;
            return cached.data;
        }
        return null;
    }

    buildUrl(endpoint, params) {
        const url = new URL(`${this.config.BASE_URL}${endpoint}`);
        url.searchParams.append('apiKey', this.config.API_KEY);
        Object.entries(params).forEach(([key, value]) => {
            url.searchParams.append(key, value);
        });
        return url.toString();
    }

    getRequestOptions() {
        return {
            headers: {
                'Content-Type': 'application/json'
            }
        };
    }

    getCacheKey(url, userId) {
        return `${userId}:${url}`;
    }

    getFromCache(key) {
        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.timestamp < this.config.CACHE_DURATION) {
            return cached.data;
        }
        return null;
    }

    updateCache(key, data) {
        this.cache.set(key, {
            data,
            timestamp: Date.now()
        });
    }

    checkUserQuota(userId) {
        const session = this.userSessions.get(userId) || this.createUserSession(userId);
        if (session.requests >= this.config.MAX_REQUESTS_PER_DAY) {
            throw new Error('Daily API quota exceeded');
        }
    }

    updateUserQuota(userId) {
        const session = this.userSessions.get(userId);
        session.requests++;
        this.userSessions.set(userId, session);
    }

    createUserSession(userId) {
        const session = {
            requests: 0,
            lastReset: Date.now()
        };
        this.userSessions.set(userId, session);
        return session;
    }

    cleanupCache() {
        const now = Date.now();
        for (const [key, value] of this.cache.entries()) {
            if (now - value.timestamp > this.config.CACHE_DURATION) {
                this.cache.delete(key);
            }
        }
    }
}

/* ------------------------------------------
   Cooking Timer
------------------------------------------- */
class CookingTimer {
    constructor() {
        this.duration = 0;
        this.remaining = 0;
        this.isRunning = false;
        this.interval = null;
        this.timerDisplay = document.getElementById('cookingTimer');
        this.minutesDisplay = document.getElementById('timerMinutes');
        this.secondsDisplay = document.getElementById('timerSeconds');
        this.setupControls();
    }

    setupControls() {
        document.getElementById('startTimer').addEventListener('click', () => this.start());
        document.getElementById('pauseTimer').addEventListener('click', () => this.stop());
        document.getElementById('resetTimer').addEventListener('click', () => this.reset());
    }

    setDuration(minutes) {
        this.duration = minutes * 60;
        this.remaining = this.duration;
        this.updateDisplay();
        this.timerDisplay.style.display = 'block';
    }

    start() {
        if (!this.isRunning && this.remaining > 0) {
            this.isRunning = true;
            this.interval = setInterval(() => this.tick(), 1000);
        }
    }

    stop() {
        this.isRunning = false;
        clearInterval(this.interval);
    }

    reset() {
        this.remaining = this.duration;
        this.stop();
        this.updateDisplay();
    }

    tick() {
        if (this.remaining > 0) {
            this.remaining--;
            this.updateDisplay();
        } else {
            this.stop();
            this.notifyTimerComplete();
        }
    }

    updateDisplay() {
        const minutes = Math.floor(this.remaining / 60);
        const seconds = this.remaining % 60;
        this.minutesDisplay.textContent = minutes.toString().padStart(2, '0');
        this.secondsDisplay.textContent = seconds.toString().padStart(2, '0');
    }

    notifyTimerComplete() {
        // Check for notification permission before creating a notification.
        if ("Notification" in window) {
            if (Notification.permission === "granted") {
                new Notification('Timer Complete!', {
                    body: 'Your cooking timer has finished!',
                    icon: '/icon.png'
                });
            } else if (Notification.permission !== "denied") {
                Notification.requestPermission().then(permission => {
                    if (permission === "granted") {
                        new Notification('Timer Complete!', {
                            body: 'Your cooking timer has finished!',
                            icon: '/icon.png'
                        });
                    }
                });
            }
        }
    }
}

/* ------------------------------------------
   Recipe Notes
------------------------------------------- */
class RecipeNotes {
    constructor() {
        this.notes = JSON.parse(localStorage.getItem('recipeNotes')) || {};
    }

    addNote(recipeId, note) {
        this.notes[recipeId] = note;
        this.saveNotes();
    }

    getNote(recipeId) {
        return this.notes[recipeId] || '';
    }

    saveNotes() {
        localStorage.setItem('recipeNotes', JSON.stringify(this.notes));
    }
}

/* ------------------------------------------
   Recently Viewed Recipes
------------------------------------------- */
class RecentlyViewed {
    constructor() {
        this.recipes = JSON.parse(localStorage.getItem('recentlyViewed')) || [];
        this.maxItems = 10;
        this.setupRecentView();
    }

    setupRecentView() {
        const recentBtn = document.getElementById('recentBtn');
        if (recentBtn) {
            recentBtn.addEventListener('click', () => {
                if (this.recipes.length > 0) {
                    const recentContainer = document.getElementById('recipesContainer');
                    recentContainer.innerHTML = `
                        <div class="recipes-grid" style="grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 2rem;">
                            ${this.recipes.map(recipe => `
                                <div class="recipe-card" onclick="app.showRecipeDetails(${recipe.id})" style="width: 100%; min-width: 300px;">
                                    <div class="favorite-btn ${app.favorites.isFavorite(recipe.id) ? 'active' : ''}" 
                                         data-recipe-id="${recipe.id}"
                                         onclick="event.stopPropagation(); app.favorites.toggle(${recipe.id})">
                                        <i class="fas fa-heart"></i>
                                    </div>
                                    <img src="${recipe.image}" alt="${recipe.title}" loading="lazy" style="width: 100%; height: 220px; object-fit: cover;">
                                    <div class="recipe-info" style="width: 100%;">
                                        <h3>${recipe.title}</h3>
                                        <div class="recipe-meta">
                                            <span><i class="fas fa-clock"></i> ${recipe.readyInMinutes}min</span>
                                            <span><i class="fas fa-user-friends"></i> ${recipe.servings}</span>
                                            ${recipe.vegetarian ? '<span class="badge vegetarian">Vegetarian</span>' : ''}
                                        </div>
                                        <div class="viewed-date">
                                            <small><i class="fas fa-history"></i> ${this.getTimeAgo(recipe.viewedAt)}</small>
                                        </div>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    `;
                } else {
                    document.getElementById('recipesContainer').innerHTML = `
                        <div class="no-recent">
                            <i class="fas fa-clock fa-3x"></i>
                            <h3>No Recently Viewed Recipes</h3>
                            <p>Start exploring recipes to build your history!</p>
                        </div>
                    `;
                }
            });
        }
    }

    addRecipe(recipe) {
        const now = new Date().getTime();
        recipe.viewedAt = now;
        // Remove duplicates
        this.recipes = this.recipes.filter(r => r.id !== recipe.id);
        this.recipes.unshift(recipe);
        if (this.recipes.length > this.maxItems) {
            this.recipes.pop();
        }
        this.saveRecipes();
    }

    getTimeAgo(timestamp) {
        const seconds = Math.floor((new Date().getTime() - timestamp) / 1000);
        const intervals = {
            year: 31536000,
            month: 2592000,
            week: 604800,
            day: 86400,
            hour: 3600,
            minute: 60
        };

        for (const [unit, secondsInUnit] of Object.entries(intervals)) {
            const interval = Math.floor(seconds / secondsInUnit);
            if (interval >= 1) {
                return `${interval} ${unit}${interval === 1 ? '' : 's'} ago`;
            }
        }
        return 'just now';
    }

    getRecipes() {
        return this.recipes;
    }

    saveRecipes() {
        localStorage.setItem('recentlyViewed', JSON.stringify(this.recipes));
    }
}

/* ------------------------------------------
   Favorites Management
------------------------------------------- */
class Favorites {
    constructor() {
        this.favorites = JSON.parse(localStorage.getItem('favorites')) || [];
        this.favoriteRecipes = JSON.parse(localStorage.getItem('favoriteRecipes')) || [];
        this.initializeFavoritesUI();
    }
      initializeFavoritesUI() {
          const favoritesMenu = `
              <div class="favorites-panel">
                  <div class="favorites-header">
                      <h2>My Favorite Recipes</h2>
                      <div class="favorites-counter">${this.favorites.length}</div>
                      <button class="close-favorites">
                          <i class="fas fa-times"></i>
                      </button>
                  </div>
                  <div class="favorites-grid"></div>
              </div>
          `;
          document.body.insertAdjacentHTML('beforeend', favoritesMenu);
        
          // Add event listener for close button
          document.querySelector('.close-favorites').addEventListener('click', () => {
              document.querySelector('.favorites-panel').classList.remove('active');
          });
        
          this.setupEventListeners();
      }
    setupEventListeners() {
        const favoritesBtn = document.getElementById('favoritesBtn');
        const favoritesPanel = document.querySelector('.favorites-panel');
        if (favoritesBtn && favoritesPanel) {
            favoritesBtn.addEventListener('click', () => {
                favoritesPanel.classList.toggle('active');
                this.updateFavoritesUI();
            });

            document.addEventListener('click', (e) => {
                if (!favoritesPanel.contains(e.target) && !favoritesBtn.contains(e.target)) {
                    favoritesPanel.classList.remove('active');
                }
            });
        }
    }

    updateFavoritesUI() {
        const favoritesGrid = document.querySelector('.favorites-grid');
        const favoritesCounter = document.querySelector('.favorites-counter');
        favoritesCounter.textContent = this.favorites.length;
        if (this.favoriteRecipes.length === 0) {
            favoritesGrid.innerHTML = `
                <div class="no-favorites">
                    <i class="fas fa-heart-broken"></i>
                    <p>No favorite recipes yet</p>
                </div>
            `;
            return;
        }
        favoritesGrid.innerHTML = this.favoriteRecipes.map(recipe => `
            <div class="favorite-item" onclick="app.showRecipeDetails(${recipe.id})">
                <img src="${recipe.image}" alt="${recipe.title}">
                <div class="favorite-item-info">
                    <h4>${recipe.title}</h4>
                    <div class="recipe-meta">
                        <span><i class="fas fa-clock"></i> ${recipe.readyInMinutes}min</span>
                        <span><i class="fas fa-user-friends"></i> ${recipe.servings}</span>
                    </div>
                    <button class="favorite-remove" onclick="event.stopPropagation(); app.favorites.removeFromFavorites(${recipe.id})">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            </div>
        `).join('');
    }

    async toggle(recipeId) {
        const favoriteBtn = document.querySelector(`.favorite-btn[data-recipe-id="${recipeId}"]`);
        if (favoriteBtn) {
            favoriteBtn.classList.add('favorite-btn-animating');

            if (this.isFavorite(recipeId)) {
                await this.removeFromFavorites(recipeId);
                favoriteBtn.classList.add('removing');
            } else {
                await this.addToFavorites(recipeId);
                favoriteBtn.classList.add('adding');
            }

            setTimeout(() => {
                favoriteBtn.classList.remove('favorite-btn-animating', 'adding', 'removing');
            }, 300);

            this.updateFavoritesUI();
        }
    }

    async addToFavorites(recipeId) {
        if (!this.isFavorite(recipeId)) {
            const recipe = await this.fetchRecipeDetails(recipeId);
            this.favorites.push(recipeId);
            this.favoriteRecipes.push(recipe);
            this.saveFavorites();
            this.showNotification('Recipe added to favorites!');
        }
    }

    removeFromFavorites(recipeId) {
        const index = this.favorites.indexOf(recipeId);
        if (index !== -1) {
            this.favorites.splice(index, 1);
            this.favoriteRecipes = this.favoriteRecipes.filter(recipe => recipe.id !== recipeId);
            this.saveFavorites();
            this.showNotification('Recipe removed from favorites');
        }
    }

    showNotification(message) {
        const notification = document.createElement('div');
        notification.className = 'notification';
        notification.textContent = message;
        document.body.appendChild(notification);

        setTimeout(() => {
            notification.classList.add('show');
            setTimeout(() => {
                notification.classList.remove('show');
                setTimeout(() => notification.remove(), 300);
            }, 2000);
        }, 100);
    }

    getFavoriteRecipes() {
        return this.favoriteRecipes;
    }

    async fetchRecipeDetails(recipeId) {
        const response = await fetch(`${BASE_URL}/${recipeId}/information?apiKey=${API_KEY}`);
        if (!response.ok) {
            throw new Error('API request failed');
        }
        return await response.json();
    }

    updateFavoriteButtons(recipeId) {
        document.querySelectorAll(`.favorite-btn[data-recipe-id="${recipeId}"]`)
            .forEach(btn => btn.classList.toggle('active'));
    }

    isFavorite(recipeId) {
        return this.favorites.includes(recipeId);
    }

    saveFavorites() {
        localStorage.setItem('favorites', JSON.stringify(this.favorites));
        localStorage.setItem('favoriteRecipes', JSON.stringify(this.favoriteRecipes));
    }
}

/* ------------------------------------------
   Unit Converter
------------------------------------------- */
class UnitConverter {
    constructor() {
        this.conversions = {
            cup_to_ml: 236.588,
            oz_to_g: 28.3495,
            lb_to_kg: 0.453592
        };
    }

    convert(value, fromUnit, toUnit) {
        const key = `${fromUnit}_to_${toUnit}`;
        return value * this.conversions[key];
    }
}

/* ------------------------------------------
   API Quota Tracker
------------------------------------------- */
class APIQuotaTracker {
    constructor() {
        this.quota = {
            daily: 150,
            used: this.getStoredQuota(),
            lastReset: this.getLastResetDate()
        };
        this.checkAndResetQuota();
    }

    getStoredQuota() {
        return parseInt(localStorage.getItem('apiQuotaUsed')) || 0;
    }

    getLastResetDate() {
        return localStorage.getItem('apiQuotaResetDate') || new Date().toISOString();
    }

    checkAndResetQuota() {
        const now = new Date();
        const lastReset = new Date(this.quota.lastReset);
        const isNewDay = now.getUTCDate() !== lastReset.getUTCDate();

        if (isNewDay) {
            this.quota.used = 0;
            this.quota.lastReset = now.toISOString();
            this.saveQuotaState();
        }
    }

    trackRequest(type) {
        const pointCosts = {
            recipeInfo: 1,
            complexSearch: 3,
            random: 1
        };

        this.quota.used += pointCosts[type] || 1;
        this.saveQuotaState();
        return this.getRemainingPoints();
    }

    getRemainingPoints() {
        return this.quota.daily - this.quota.used;
    }

    saveQuotaState() {
        localStorage.setItem('apiQuotaUsed', this.quota.used);
        localStorage.setItem('apiQuotaResetDate', this.quota.lastReset);
    }

    canMakeRequest(type) {
        const pointCosts = {
            recipeInfo: 1,
            complexSearch: 3,
            random: 1
        };
        return this.getRemainingPoints() >= (pointCosts[type] || 1);
    }
}

/* ------------------------------------------
   Recipe Master Application
------------------------------------------- */
class RecipeMaster {
    constructor() {
        this.searchInput = document.getElementById('search');
        this.searchBtn = document.getElementById('searchBtn');
        this.recipesContainer = document.getElementById('recipesContainer');
        this.modal = document.getElementById('recipeModal');
        this.timer = new CookingTimer();
        this.notes = new RecipeNotes();
        this.recentlyViewed = new RecentlyViewed();
        this.favorites = new Favorites();
        this.converter = new UnitConverter();
        this.quotaTracker = new APIQuotaTracker();
        this.api = new APIClient(config);
        this.userId = this.getUserId();
        this.lastOffset = 0;
        this.seenRecipes = new Set();
        this.activeFilters = new Map(); // Track active filters

        this.init();
        this.cleanupCache();
        setInterval(() => this.cleanupCache(), 6 * 60 * 60 * 1000); // Every 6 hours
    }

    getUserId() {
        let userId = localStorage.getItem('userId');
        if (!userId) {
            userId = 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            localStorage.setItem('userId', userId);
        }
        return userId;
    }

    init() {
        // Ensure we define app globally first
        window.app = this;
        
        this.setupEventListeners();
        this.setupCategoryNavigation();
        this.setupFilterListeners(); // Now this will exist
        this.setupThemeToggle();
        this.loadAllRecipes();
    }

    setupEventListeners() {
        if (this.searchBtn && this.searchInput) {
            this.searchBtn.addEventListener('click', () => this.searchRecipes());
            this.searchInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') this.searchRecipes();
            });
        }

        // Advanced filter controls
        document.getElementById('cuisine')?.addEventListener('change', () => this.applyFilters());
        document.getElementById('diet')?.addEventListener('change', () => this.applyFilters());
        document.getElementById('time')?.addEventListener('change', () => this.applyFilters());

        document.getElementById('advancedFiltersBtn')?.addEventListener('click', () => {
            const advancedFilters = document.querySelector('.advanced-filters');
            if (advancedFilters) {
                advancedFilters.style.display = advancedFilters.style.display === 'none' ? 'block' : 'none';
            }
        });

        const caloriesRange = document.getElementById('caloriesRange');
        const caloriesValue = document.getElementById('caloriesValue');
        if (caloriesRange && caloriesValue) {
            caloriesRange.addEventListener('input', (e) => {
                caloriesValue.textContent = `${e.target.value} cal`;
                this.applyFilters();
            });
        }

        ['vegetarian', 'vegan', 'glutenFree', 'dairyFree'].forEach(pref => {
            document.getElementById(pref)?.addEventListener('change', () => this.applyFilters());
        });
    }
      setupCategoryNavigation() {
          const categoryButtons = document.querySelectorAll('.category-btn');
          categoryButtons.forEach(button => {
              button.addEventListener('click', (e) => {
                  // Remove active class from all buttons
                  categoryButtons.forEach(btn => btn.classList.remove('active'));
                  // Add active class to clicked button
                  e.target.classList.add('active');
                
                  const category = button.dataset.category;
                  this.filterByCategory(category);
              });
          });
      }
    setupThemeToggle() {
        const themeToggle = document.querySelector('.theme-toggle');
        if (themeToggle) {
            // Check system preference
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            const savedTheme = localStorage.getItem('theme');
            
            // Set initial theme
            if (savedTheme === 'dark' || (!savedTheme && prefersDark)) {
                document.body.classList.add('dark-mode');
            }
            
            themeToggle.addEventListener('click', () => {
                document.body.classList.toggle('dark-mode');
                const isDark = document.body.classList.contains('dark-mode');
                localStorage.setItem('theme', isDark ? 'dark' : 'light');
                
                // Update UI elements for current theme
                this.updateThemeSpecificUI(isDark);
            });
        }
    }

    updateThemeSpecificUI(isDark) {
        // Update modal backgrounds
        const modals = document.querySelectorAll('.modal-content');
        modals.forEach(modal => {
            modal.style.background = isDark ? 'var(--dark-card)' : 'var(--card-bg)';
        });
        
        // Update inputs and selects
        const inputs = document.querySelectorAll('input, select');
        inputs.forEach(input => {
            input.style.background = isDark ? 'var(--dark-input)' : 'var(--card-bg)';
        });
        
        // Update filter chips
        const filterChips = document.querySelectorAll('.filter-chip');
        filterChips.forEach(chip => {
            chip.style.background = isDark ? 'var(--dark-input)' : 'var(--card-bg)';
        });
    }

    async searchRecipes() {
        const query = this.searchInput.value.trim();
        if (!query) return;

        try {
            this.showLoader();
            const data = await this.api.request('/complexSearch', {
                query,
                number: 24,
                addRecipeInformation: true,
                sort: 'popularity', // Sort by popularity
                ranking: 2, // Prioritize popular recipes
                fillIngredients: true
            }, this.userId, 2); // Higher priority for search requests
            
            const balancedResults = this.balanceRecipeResults(data.results);
            this.displayRecipes(balancedResults);
        } catch (error) {
            this.handleAPIError(error);
        } finally {
            this.hideLoader();
        }
    }

    handleAPIError(error) {
        if (error.message === 'Daily API quota exceeded') {
            this.showError('You have reached your daily limit. Please try again tomorrow.');
        } else {
            this.showError('An error occurred. Please try again later.');
        }
        console.error('API Error:', error);
    }

    buildFilterParams() {
        const params = {};
        
        // Cuisine filter
        const cuisine = document.getElementById('cuisine')?.value;
        if (cuisine) params.cuisine = cuisine;
        
        // Diet filter
        const diet = document.getElementById('diet')?.value;
        if (diet) params.diet = diet;
        
        // Time filter
        const time = document.getElementById('time')?.value;
        if (time) params.maxReadyTime = parseInt(time);
        
        // Calories filter
        const calories = document.getElementById('caloriesRange')?.value;
        if (calories) params.maxCalories = parseInt(calories);
        
        // Dietary restrictions
        const vegetarian = document.getElementById('vegetarian')?.checked;
        if (vegetarian) params.vegetarian = true;
        
        const vegan = document.getElementById('vegan')?.checked;
        if (vegan) params.vegan = true;
        
        const glutenFree = document.getElementById('glutenFree')?.checked;
        if (glutenFree) params.glutenFree = true;
        
        const dairyFree = document.getElementById('dairyFree')?.checked;
        if (dairyFree) {
            params.intolerances = params.intolerances ? 
                `${params.intolerances},dairy` : 'dairy';
        }

        // Additional parameters for better results
        params.instructionsRequired = true;
        params.fillIngredients = true;
        params.addRecipeInformation = true;
        params.addRecipeNutrition = true;
        
        return params;
    }

    async applyFilters() {
        try {
            this.showLoader();
            
            const params = this.buildFilterParams();
            
            // Ensure we have at least one filter active
            if (Object.keys(params).length > 3) { // More than just the default params
                const data = await this.api.request('/complexSearch', {
                    ...params,
                    number: 24,
                    sort: this.getSortParameter(params),
                    ranking: 2
                }, this.userId, 1);

                if (data.results.length === 0) {
                    this.showError('No recipes found with these filters. Try adjusting your criteria.');
                    return;
                }

                const strictlyFilteredResults = this.enforceFilters(data.results);
                this.displayRecipes(strictlyFilteredResults);
            } else {
                this.loadAllRecipes();
            }

            this.updateFilterUI();
        } catch (error) {
            this.handleAPIError(error);
        } finally {
            this.hideLoader();
        }
    }

    enforceFilters(recipes) {
        if (!recipes || !Array.isArray(recipes)) return [];

        return recipes.filter(recipe => {
            // Check each active filter
            for (const [filter, value] of this.activeFilters) {
                switch (filter) {
                    case 'cuisine':
                        if (!recipe.cuisines?.includes(value)) return false;
                        break;
                    case 'diet':
                        if (!recipe.diets?.includes(value)) return false;
                        break;
                    case 'maxReadyTime':
                        if (recipe.readyInMinutes > parseInt(value)) return false;
                        break;
                    case 'maxCalories':
                        const calories = recipe.nutrition?.nutrients?.find(n => n.name === 'Calories')?.amount;
                        if (!calories || calories > parseInt(value)) return false;
                        break;
                    case 'vegetarian':
                        if (!recipe.vegetarian) return false;
                        break;
                    case 'vegan':
                        if (!recipe.vegan) return false;
                        break;
                    case 'glutenFree':
                        if (!recipe.glutenFree) return false;
                        break;
                    case 'dairyFree':
                        if (!recipe.dairyFree) return false;
                        break;
                }
            }
            return true;
        });
    }

    getSortParameter(params) {
        if (params.maxReadyTime) return 'time';
        if (params.maxCalories) return 'calories';
        if (params.vegetarian || params.vegan) return 'healthiness';
        return 'popularity';
    }

    updateActiveFilters(params) {
        this.activeFilters.clear();
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== '' && value !== false) {
                this.activeFilters.set(key, value);
            }
        });
    }

    updateFilterUI() {
        // Update filter indicators
        const filterIndicators = document.querySelector('.active-filters') || 
            this.createFilterIndicators();

        if (this.activeFilters.size > 0) {
            filterIndicators.innerHTML = Array.from(this.activeFilters).map(([filter, value]) => `
                <div class="filter-indicator">
                    <span>${this.formatFilterName(filter)}</span>
                    <button onclick="app.removeFilter('${filter}')">×</button>
                </div>
            `).join('');
            filterIndicators.style.display = 'flex';
        } else {
            filterIndicators.style.display = 'none';
        }

        // Update filter controls
        this.updateFilterControls();
    }

    createFilterIndicators() {
        const container = document.createElement('div');
        container.className = 'active-filters';
        document.querySelector('.filters').appendChild(container);
        return container;
    }

    removeFilter(filterName) {
        // Remove the filter
        this.activeFilters.delete(filterName);

        // Reset the corresponding control
        const element = document.getElementById(filterName);
        if (element) {
            if (element.type === 'checkbox') {
                element.checked = false;
            } else {
                element.value = '';
            }
        }

        // Reapply remaining filters
        this.applyFilters();
    }

    resetFilters() {
        this.activeFilters.clear();
        const filters = ['cuisine', 'diet', 'time'];
        const checkboxes = ['vegetarian', 'vegan', 'glutenFree', 'dairyFree', 'highProtein'];
        
        // Reset dropdowns
        filters.forEach(filter => {
            const element = document.getElementById(filter);
            if (element) {
                element.value = '';
                element.classList.remove('filter-active');
            }
        });

        // Reset checkboxes
        checkboxes.forEach(checkbox => {
            const element = document.getElementById(checkbox);
            if (element) {
                element.checked = false;
                element.closest('.filter-chip').classList.remove('active');
            }
        });

        // Reset calories range
        const caloriesRange = document.getElementById('caloriesRange');
        if (caloriesRange) {
            caloriesRange.value = 500;
            document.getElementById('caloriesValue').textContent = '500 cal';
        }

        // Clear search input
        if (this.searchInput) this.searchInput.value = '';

        // Reload recipes with cleared filters
        this.loadAllRecipes();
    }

    // Add these helper methods
    formatFilterName(filter) {
        return filter
            .replace(/([A-Z])/g, ' $1')
            .replace(/^./, str => str.toUpperCase())
            .replace(/max/i, '')
            .trim();
    }

    updateFilterControls() {
        // Update visual state of filter controls
        document.querySelectorAll('select, input[type="checkbox"]').forEach(element => {
            const filterId = element.id;
            const isActive = this.activeFilters.has(filterId);
            
            if (element.tagName === 'SELECT') {
                element.classList.toggle('active', isActive);
            } else {
                const chip = element.closest('.filter-chip');
                if (chip) {
                    chip.classList.toggle('active', isActive);
                }
            }
        });
    }

    async filterByCategory(category) {
        if (category === 'all') {
            this.loadAllRecipes();
            return;
        }

        try {
            this.showLoader();
            const data = await this.api.request('/complexSearch', {
                type: category,
                number: 24,
                addRecipeInformation: true,
                sort: 'popularity',
                ranking: 2
            }, this.userId, 1); // Normal priority for category filters
            
            const balancedResults = this.balanceRecipeResults(data.results);
            this.displayRecipes(balancedResults);
        } catch (error) {
            this.handleAPIError(error);
        } finally {
            this.hideLoader();
        }
    }

    async loadAllRecipes() {
        try {
            this.showLoader();
            
            // Reset seen recipes if we've seen too many
            if (this.seenRecipes.size > 1000) {
                this.seenRecipes.clear();
                this.lastOffset = 0;
            }

            // Get random offset for variety
            const maxOffset = 900; // Spoonacular has about 1000 base recipes
            let offset = Math.floor(Math.random() * maxOffset);
            
            // Ensure we don't get the same offset twice in a row
            while (Math.abs(offset - this.lastOffset) < 24) {
                offset = Math.floor(Math.random() * maxOffset);
            }
            
            const response = await this.api.request('/random', {
                number: 24,
                tags: 'main course', // Ensures we get proper meals
                addRecipeInformation: true,
                limitLicense: true,
                sort: 'random',
                offset: offset
            }, this.userId, 1);

            // Filter out recipes we've seen recently
            const newRecipes = response.recipes.filter(recipe => 
                !this.seenRecipes.has(recipe.id)
            );

            // Add new recipes to seen set
            newRecipes.forEach(recipe => this.seenRecipes.add(recipe.id));

            // Update last offset
            this.lastOffset = offset;

            // Apply our normal balancing and sorting
            const balancedResults = this.balanceRecipeResults(newRecipes);
            
            // Add variety scores
            const variedResults = this.addVarietyScores(balancedResults);
            
            this.displayRecipes(variedResults);
        } catch (error) {
            this.showError('Failed to load recipes. Please try again.');
        } finally {
            this.hideLoader();
        }
    }

    addVarietyScores(recipes) {
        // Group recipes by cuisine and type
        const cuisineGroups = {};
        const typeGroups = {};
        
        recipes.forEach(recipe => {
            if (recipe.cuisines && recipe.cuisines.length > 0) {
                recipe.cuisines.forEach(cuisine => {
                    cuisineGroups[cuisine] = (cuisineGroups[cuisine] || 0) + 1;
                });
            }
            if (recipe.dishTypes && recipe.dishTypes.length > 0) {
                recipe.dishTypes.forEach(type => {
                    typeGroups[type] = (typeGroups[type] || 0) + 1;
                });
            }
        });

        // Calculate variety score for each recipe
        return recipes.map(recipe => {
            let varietyScore = recipe.spoonacularScore || 0;
            
            // Boost unique cuisines and dish types
            if (recipe.cuisines && recipe.cuisines.length > 0) {
                const cuisineScore = recipe.cuisines.reduce((score, cuisine) => 
                    score + (1 / cuisineGroups[cuisine]), 0);
                varietyScore += cuisineScore * 10;
            }
            
            if (recipe.dishTypes && recipe.dishTypes.length > 0) {
                const typeScore = recipe.dishTypes.reduce((score, type) => 
                    score + (1 / typeGroups[type]), 0);
                varietyScore += typeScore * 10;
            }

            return {
                ...recipe,
                varietyScore
            };
        }).sort((a, b) => b.varietyScore - a.varietyScore);
    }

    balanceRecipeResults(recipes) {
        if (!recipes || !Array.isArray(recipes)) return [];

        // Don't balance if specific dietary filters are active
        if (document.getElementById('vegetarian')?.checked) {
            return recipes;
        }

        // Sort by rating and popularity
        recipes.sort((a, b) => {
            const scoreA = (a.spoonacularScore || 0) + (a.aggregateLikes || 0) / 100;
            const scoreB = (b.spoonacularScore || 0) + (b.aggregateLikes || 0) / 100;
            return scoreB - scoreA;
        });

        // Separate vegetarian and non-vegetarian recipes
        const vegetarianRecipes = recipes.filter(r => r.vegetarian);
        const regularRecipes = recipes.filter(r => !r.vegetarian);

        // Calculate target numbers based on preferences
        const totalCount = recipes.length;
        const targetVegetarian = Math.floor(totalCount * RECIPE_PREFERENCES.defaultDietaryBalance.vegetarian);
        const targetRegular = totalCount - targetVegetarian;

        // Combine recipes maintaining the ratio
        return [
            ...regularRecipes.slice(0, targetRegular),
            ...vegetarianRecipes.slice(0, targetVegetarian)
        ].sort(() => Math.random() - 0.5); // Shuffle the results
    }

    displayRecipes(recipes) {
        if (!Array.isArray(recipes) || recipes.length === 0) {
            this.recipesContainer.innerHTML = `
                <div class="no-results">
                    <i class="fas fa-search fa-3x"></i>
                    <h3>No Recipes Found</h3>
                    <p>Try adjusting your search criteria</p>
                </div>
            `;
            return;
        }

        this.recipesContainer.innerHTML = recipes.map(recipe => `
            <div class="recipe-card" onclick="app.showRecipeDetails(${recipe.id})">
                <div class="favorite-btn ${this.favorites.isFavorite(recipe.id) ? 'active' : ''}" 
                     data-recipe-id="${recipe.id}"
                     onclick="event.stopPropagation(); app.favorites.toggle(${recipe.id})">
                    <i class="fas fa-heart"></i>
                </div>
                <img src="${recipe.image}" alt="${recipe.title}" loading="lazy">
                <div class="recipe-info">
                    <h3>${recipe.title}</h3>
                    <div class="recipe-meta">
                        <span><i class="fas fa-clock"></i> ${recipe.readyInMinutes}min</span>
                        <span><i class="fas fa-user-friends"></i> ${recipe.servings}</span>
                        ${recipe.vegetarian ? '<span class="badge vegetarian">Vegetarian</span>' : ''}
                    </div>
                </div>
            </div>
        `).join('');
    }

    async showRecipeDetails(id) {
        try {
            const recipe = await this.fetchRecipeDetails(id);
            this.recentlyViewed.addRecipe(recipe);
            this.displayRecipeModal(recipe);
        } catch (error) {
            this.showError('Failed to load recipe details.');
        }
    }

    async fetchRecipeDetails(id) {
        // Check cache first
        const cached = localStorage.getItem(`recipe_${id}`);
        if (cached) {
            const { data, timestamp } = JSON.parse(cached);
            if (Date.now() - timestamp < config.CACHE_DURATION) {
                return data;
            }
        }

        // If not in cache or expired, fetch from API
        try {
            const response = await fetch(`${BASE_URL}/${id}/information?apiKey=${API_KEY}`);
            if (!response.ok) throw new Error('API request failed');
            const data = await response.json();
            
            // Cache the response
            localStorage.setItem(`recipe_${id}`, JSON.stringify({
                data,
                timestamp: Date.now()
            }));
            
            return data;
        } catch (error) {
            throw new Error('Failed to fetch recipe details');
        }
    }

    cleanInstructionText(instruction) {
        if (!instruction) return '';
        
        return instruction
            // Remove numbers and dots from start
            .replace(/^[\d\s.]+/g, '')
            // Remove social media related text
            .replace(/Join \d+,\d+ SUBSCRIBERS!.*?Kit/gs, '')
            // Remove email subscription text
            .replace(/Sign up to receive.*?Convert/gs, '')
            // Remove any remaining numbered lines
            .replace(/^\d+\.?\s*/gm, '')
            // Clean up multiple spaces and newlines
            .replace(/\s+/g, ' ')
            // Final trim
            .trim();
    }

    displayRecipeModal(recipe) {
        const modalContent = `
            <div class="modal-content">
                <span class="close-modal" onclick="app.closeModal()">&times;</span>
                <div class="recipe-hero">
                    <img src="${recipe.image}" alt="${recipe.title}">
                    <div class="recipe-hero-overlay">
                        <h2>${recipe.title}</h2>
                        <div class="recipe-stats">
                            <span><i class="fas fa-clock"></i> ${recipe.readyInMinutes}min</span>
                            <span><i class="fas fa-user-friends"></i> ${recipe.servings} servings</span>
                            <span><i class="fas fa-fire"></i> ${recipe.calories || 'N/A'} cal</span>
                        </div>
                    </div>
                </div>
                <div class="recipe-details">
                    <div class="recipe-ingredients">
                        <h3>Ingredients:</h3>
                        <ul class="ingredients-grid">
                            ${recipe.extendedIngredients.map(ingredient => `
                                <li class="ingredient-item">
                                    <img src="https://spoonacular.com/cdn/ingredients_100x100/${ingredient.image}" 
                                         alt="${ingredient.name}"
                                         onerror="this.src='placeholder.png'">
                                    <span>${ingredient.original}</span>
                                </li>
                            `).join('')}
                        </ul>
                    </div>
                    <div class="recipe-instructions">
                        <h3>Instructions:</h3>
                        <div class="instructions-container">
                            <ol class="steps-list">
                                ${recipe.analyzedInstructions[0]?.steps.map((step, index) => {
                                    const cleanedStep = this.cleanInstructionText(step.step);
                                    const equipmentList = step.equipment?.map(eq => eq.name).join(', ');
                                    const ingredientList = step.ingredients?.map(ing => ing.name).join(', ');
                                    
                                    return `
                                        <li class="step-item">
                                            <div class="step-header">
                                                <span class="step-number">${index + 1}</span>
                                                <span class="step-time">${step.length?.number ? `${step.length.number} ${step.length.unit}` : ''}</span>
                                            </div>
                                            <div class="step-content">
                                                <p class="step-text">${cleanedStep}</p>
                                                ${equipmentList ? `
                                                    <div class="step-equipment">
                                                        <i class="fas fa-utensils"></i>
                                                        <span>Equipment: ${equipmentList}</span>
                                                    </div>
                                                ` : ''}
                                                ${ingredientList ? `
                                                    <div class="step-ingredients">
                                                        <i class="fas fa-carrot"></i>
                                                        <span>Ingredients: ${ingredientList}</span>
                                                    </div>
                                                ` : ''}
                                            </div>
                                        </li>
                                    `;
                                }).join('') || '<p>No instructions available.</p>'}
                            </ol>
                        </div>
                    </div>
                </div>
            </div>
        `;
        this.modal.innerHTML = modalContent;
        this.modal.style.display = 'block';

        if (recipe.readyInMinutes) {
            this.timer.setDuration(recipe.readyInMinutes);
        }
    }

    closeModal() {
        this.modal.style.display = 'none';
        this.timer.stop();
    }

    showLoader() {
        this.recipesContainer.innerHTML = '<div class="loader">Loading...</div>';
    }

    hideLoader() {
        const loader = document.querySelector('.loader');
        if (loader) loader.remove();
    }

    showError(message) {
        this.recipesContainer.innerHTML = `<div class="error">${message}</div>`;
    }

    updateActiveFilters() {
        // Update dropdown filters
        ['cuisine', 'diet', 'time'].forEach(filter => {
            const element = document.getElementById(filter);
            if (element?.value) {
                element.classList.add('filter-active');
            } else {
                element.classList.remove('filter-active');
            }
        });

        // Update checkbox filters
        ['vegetarian', 'vegan', 'glutenFree', 'dairyFree', 'highProtein'].forEach(filter => {
            const element = document.getElementById(filter);
            if (element?.checked) {
                element.closest('.filter-chip').classList.add('active');
            } else {
                element.closest('.filter-chip').classList.remove('active');
            }
        });
    }

    // Add a cache cleanup method
    cleanupCache() {
        const now = Date.now();
        Object.keys(localStorage).forEach(key => {
            if (key.startsWith('recipe_') || key.startsWith('search_')) {
                const cached = JSON.parse(localStorage.getItem(key));
                if (now - cached.timestamp > config.CACHE_DURATION) {
                    localStorage.removeItem(key);
                }
            }
        });
    }

    setupFilterListeners() {
        // Immediate filter elements
        ['cuisine', 'diet', 'time'].forEach(filterId => {
            const element = document.getElementById(filterId);
            if (element) {
                element.addEventListener('change', () => {
                    this.debounce(() => this.applyFilters(), 300)();
                });
            }
        });

        // Advanced filter elements
        const advancedFilters = ['vegetarian', 'vegan', 'glutenFree', 'dairyFree'];
        advancedFilters.forEach(filterId => {
            const element = document.getElementById(filterId);
            if (element) {
                element.addEventListener('change', () => {
                    this.debounce(() => this.applyFilters(), 300)();
                });
            }
        });

        // Calories range with debouncing
        const caloriesRange = document.getElementById('caloriesRange');
        if (caloriesRange) {
            caloriesRange.addEventListener('input', (e) => {
                const caloriesValue = document.getElementById('caloriesValue');
                if (caloriesValue) {
                    caloriesValue.textContent = `${e.target.value} cal`;
                }
                this.debounce(() => this.applyFilters(), 500)();
            });
        }

        // Reset filters
        document.querySelector('.clear-filters')?.addEventListener('click', () => {
            this.resetFilters();
            this.loadAllRecipes();
        });
    }

    debounce(func, wait) {
        let timeout;
        return (...args) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }
}

// Remove the existing initialization code and replace with:
document.addEventListener('DOMContentLoaded', () => {
    const app = new RecipeMaster();
    // Apply saved theme preference
    if (localStorage.getItem('theme') === 'dark') {
        document.body.classList.add('dark-mode');
    }
});
