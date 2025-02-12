import { config } from './config.js';
const { API_KEY, BASE_URL } = config;

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

        this.init();
        this.cleanupCache();
        setInterval(() => this.cleanupCache(), 6 * 60 * 60 * 1000); // Every 6 hours
    }

    init() {
        this.setupEventListeners();
        this.setupCategoryNavigation();
        this.loadAllRecipes();
        this.setupThemeToggle();
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
            themeToggle.addEventListener('click', () => {
                document.body.classList.toggle('dark-mode');
                localStorage.setItem('theme', document.body.classList.contains('dark-mode') ? 'dark' : 'light');
            });
        }
    }

    async searchRecipes() {
        const query = this.searchInput.value.trim();
        if (!query) return;

        // Check cache first
        const cacheKey = `search_${query}`;
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
            const { data, timestamp } = JSON.parse(cached);
            if (Date.now() - timestamp < config.CACHE_DURATION) {
                this.displayRecipes(data.results);
                return;
            }
        }

        try {
            this.showLoader();
            const response = await fetch(
                `${BASE_URL}/complexSearch?apiKey=${API_KEY}&query=${encodeURIComponent(query)}&number=24&addRecipeInformation=true`
            );
            if (!response.ok) throw new Error('API request failed');
            const data = await response.json();

            // Cache the response
            localStorage.setItem(cacheKey, JSON.stringify({
                data,
                timestamp: Date.now()
            }));

            this.displayRecipes(data.results);
        } catch (error) {
            console.error('Error fetching recipes:', error);
            this.showError('Failed to fetch recipes. Please try again.');
        } finally {
            this.hideLoader();
        }
    }

    async applyFilters() {
        const cuisine = document.getElementById('cuisine')?.value;
        const diet = document.getElementById('diet')?.value;
        const maxTime = document.getElementById('time')?.value;
        const maxCalories = document.getElementById('caloriesRange')?.value;
        const highProtein = document.getElementById('highProtein')?.checked;
        const query = this.searchInput.value.trim();

        try {
            this.showLoader();
            let url = `${BASE_URL}/complexSearch?apiKey=${API_KEY}&number=24&addRecipeInformation=true`;

            // Add basic filters
            if (cuisine) url += `&cuisine=${encodeURIComponent(cuisine)}`;
            if (diet) url += `&diet=${encodeURIComponent(diet)}`;
            if (maxTime) url += `&maxReadyTime=${encodeURIComponent(maxTime)}`;
            if (maxCalories) url += `&maxCalories=${encodeURIComponent(maxCalories)}`;
            if (query) url += `&query=${encodeURIComponent(query)}`;
            if (highProtein) url += '&minProtein=25'; // Add high protein requirement

            const response = await fetch(url);
            const data = await response.json();

            // Apply additional dietary filters
            const filteredResults = data.results.filter(recipe => {
                const matchesVegetarian = !document.getElementById('vegetarian')?.checked || recipe.vegetarian;
                const matchesVegan = !document.getElementById('vegan')?.checked || recipe.vegan;
                const matchesGlutenFree = !document.getElementById('glutenFree')?.checked || recipe.glutenFree;
                const matchesDairyFree = !document.getElementById('dairyFree')?.checked || recipe.dairyFree;
                
                return matchesVegetarian && matchesVegan && matchesGlutenFree && matchesDairyFree;
            });

            this.displayRecipes(filteredResults);

            // Update UI to show active filters
            this.updateActiveFilters();

            // Reset filters display
            document.querySelector('.advanced-filters').style.display = 'none';

        } catch (error) {
            this.showError('Failed to apply filters. Please try again.');
        } finally {
            this.hideLoader();
        }
    }

    async filterByCategory(category) {
        if (category === 'all') {
            this.loadAllRecipes();
            return;
        }

        const categoryMappings = {
            breakfast: 'breakfast',
            lunch: 'main course&maxReadyTime=30&sort=time', // Quick lunch options
            dinner: 'main course&sort=popularity&excludeIngredients=sandwich,salad', // More substantial dinner dishes
            desserts: 'dessert'
        };

        try {
            this.showLoader();
            const response = await fetch(
                `${BASE_URL}/complexSearch?apiKey=${API_KEY}&type=${encodeURIComponent(categoryMappings[category])}&number=24&addRecipeInformation=true`
            );
            if (!response.ok) throw new Error('API request failed');
            const data = await response.json();
            this.displayRecipes(data.results);
        } catch (error) {
            this.showError('Failed to filter recipes. Please try again.');
        } finally {
            this.hideLoader();
        }
    }

    async loadAllRecipes() {
        try {
            this.showLoader();
            const response = await fetch(
                `${BASE_URL}/complexSearch?apiKey=${API_KEY}&number=24&addRecipeInformation=true`
            );
            if (!response.ok) throw new Error('API request failed');
            const data = await response.json();
            this.displayRecipes(data.results);
        } catch (error) {
            this.showError('Failed to load recipes. Please try again.');
        } finally {
            this.hideLoader();
        }
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

    displayRecipeModal(recipe) {
        const modalContent = `
            <div class="modal-content">
                <span class="close-modal" onclick="app.closeModal()">&times;</span>
                <h2>${recipe.title}</h2>
                <img src="${recipe.image}" alt="${recipe.title}">
                <div class="recipe-details">
                    <h3>Ingredients:</h3>
                    <ul>
                        ${recipe.extendedIngredients.map(ingredient => 
                            `<li>${ingredient.original}</li>`
                        ).join('')}
                    </ul>
                    <h3>Instructions:</h3>
                    <ol>
                        ${recipe.analyzedInstructions[0]?.steps.map(step => 
                            `<li>${step.step}</li>`
                        ).join('') || '<p>No instructions available.</p>'}
                    </ol>
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

    // Add this method to handle filter reset
    resetFilters() {
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

        // Reload all recipes
        this.loadAllRecipes();
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
}

// Initialize the application
const app = new RecipeMaster();

// Apply saved theme preference
if (localStorage.getItem('theme') === 'dark') {
    document.body.classList.add('dark-mode');
}

// Make app globally accessible for inline event handlers
window.app = app;
