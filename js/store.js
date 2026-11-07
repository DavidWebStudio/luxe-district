/**
 * LUXE DISTRICT: Storefront
 * Loads products from Supabase, runs the shopping bag, search and filters,
 * and sends orders to WhatsApp after the database confirms them.
 *
 * SECURITY NOTE
 * The publishable key below is safe in browser code only because Row Level
 * Security protects your tables. Prices and stock are re-checked by the
 * `place_store_order` database function, never trusted from this page.
 */

document.addEventListener("DOMContentLoaded", () => {
    "use strict";

    /* ==========================================================
       1. CONFIGURATION
       ========================================================== */

    const CONFIG = Object.freeze({
        supabaseUrl: "https://qzegfwfexkneowkudatl.supabase.co",
        supabaseKey: "sb_publishable_2TF6O8Bt-FqdO3bDY4jLtw_k3Eq1-Ya",

        // Digits only, with country code
        whatsappNumber: "2347085408445",

        currency: "NGN",
        locale: "en-NG",
        maxPerItem: 99,
        lowStockThreshold: 5,
        mobileNavBreakpoint: 1180,
        searchDebounceMs: 200,
        toastDurationMs: 3000,
        longToastDurationMs: 9000,

        // Keep false until the idempotent order function (proposed SQL) has been
        // approved and installed. Sending the key earlier would make the
        // existing function reject the call.
        sendIdempotencyKey: false,

        cartStorageKey: "luxeDistrictCart",
        favouritesStorageKey: "luxeDistrictFavourites",
        checkoutKeyStorageKey: "luxeDistrictCheckoutKey"
    });

    const CATEGORY_LABELS = Object.freeze({
        clothing: "Clothing",
        bags: "Bags",
        shoes: "Shoes",
        perfume: "Fragrances"
    });

    const supabaseClient = window.supabase
        ? window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey)
        : null;


    /* ==========================================================
       2. PAGE ELEMENTS
       ========================================================== */

    const $ = (selector) => document.querySelector(selector);

    const el = {
        productGrid: $("#product-grid"),
        resultsStatus: $("#results-status"),
        filterButtons: document.querySelectorAll(".filter-button"),

        cartButton: $(".cart-button"),
        cartCount: $(".cart-count"),
        cartDrawer: $(".cart-drawer"),
        cartOverlay: $(".cart-overlay"),
        cartClose: $(".cart-close"),
        cartItems: $(".cart-items"),
        cartHeadingCount: $(".cart-heading-count"),
        cartTotal: $(".cart-total"),
        checkoutButton: $(".checkout-button"),
        continueShopping: $(".continue-shopping"),

        menuToggle: $(".menu-toggle"),
        mainNavigation: $(".main-navigation"),

        searchButton: $(".search-button"),
        searchOverlay: $(".search-overlay"),
        searchClose: $(".search-close"),
        searchForm: $(".search-form"),
        searchInput: $("#product-search"),

        newsletterForm: $(".newsletter-form"),
        toast: $(".toast-message"),
        currentYear: $("#current-year"),

        // Parts of the page that become unreachable while a panel is open
        pageParts: document.querySelectorAll(".announcement-bar, .site-header, main, .site-footer")
    };


    /* ==========================================================
       3. STATE
       ========================================================== */

    const state = {
        products: [],
        productsLoaded: false,
        cart: [],
        favourites: new Set(),
        activeFilter: "all",
        searchTerm: "",
        isCheckingOut: false,
        cartNotice: null, // { title, text, linkLabel, linkUrl } shown at the top of the bag
        toastTimer: null
    };


    /* ==========================================================
       4. HELPERS
       ========================================================== */

    const priceFormatter = new Intl.NumberFormat(CONFIG.locale, {
        style: "currency",
        currency: CONFIG.currency,
        maximumFractionDigits: 0
    });

    const formatPrice = (amount) => priceFormatter.format(Number(amount) || 0);

    const sameId = (a, b) => String(a) === String(b);

    function debounce(callback, delay) {
        let timer;

        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => callback(...args), delay);
        };
    }

    function escapeHTML(value) {
        const entities = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        };

        return String(value ?? "").replace(/[&<>"']/g, (character) => entities[character]);
    }

    function parseUrl(value) {
        try {
            return new URL(value);
        } catch {
            return null;
        }
    }

    const isHttpsUrl = (value) => parseUrl(String(value || ""))?.protocol === "https:";

    /** Allows in-page anchors, site paths and HTTPS links only. */
    function isSafeLink(value) {
        const link = String(value || "").trim();

        if (link.startsWith("#")) return link.length > 1;
        if (link.startsWith("/")) return !link.startsWith("//");

        return isHttpsUrl(link);
    }

    function readStorage(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (error) {
            console.warn(`Could not read "${key}" from storage.`, error);
            return fallback;
        }
    }

    function writeStorage(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (error) {
            console.warn(`Could not save "${key}" to storage.`, error);
            return false;
        }
    }

    function showToast(message, duration = CONFIG.toastDurationMs) {
        if (!el.toast) return;

        el.toast.textContent = message;
        el.toast.classList.add("is-visible");

        clearTimeout(state.toastTimer);
        state.toastTimer = setTimeout(() => {
            el.toast.classList.remove("is-visible");
        }, duration);
    }

    /** While a panel is open, the page behind it cannot be focused or read aloud. */
    function setPageInert(inert) {
        el.pageParts.forEach((part) => part.toggleAttribute("inert", inert));
    }

    const findProduct = (id) => state.products.find((product) => sameId(product.id, id));

    // Shown when a product photo is missing or fails to load
    const PLACEHOLDER_IMAGE =
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 1000'%3E%3Crect width='800' height='1000' fill='%23EDE8DF'/%3E%3Ctext x='400' y='520' font-size='96' text-anchor='middle' fill='%23B08D57' font-family='Georgia,serif'%3ELD%3C/text%3E%3C/svg%3E";

    const safeImageUrl = (value) => (isHttpsUrl(value) ? value : PLACEHOLDER_IMAGE);

    /** First failure swaps in the placeholder. A second failure hides the image. */
    function handleImageError(event) {
        const image = event.target;

        if (!(image instanceof HTMLImageElement)) return;
        if (!image.classList.contains("product-image") && !image.classList.contains("cart-item-image")) return;

        if (image.dataset.fallbackApplied) {
            image.classList.add("is-broken");
            return;
        }

        image.dataset.fallbackApplied = "true";
        image.src = PLACEHOLDER_IMAGE;
    }


    /* ==========================================================
       5. STOCK RULES
       ========================================================== */

    // A missing stock value means "not tracked", so it counts as unlimited.
    function getStock(product) {
        if (product.stock === undefined || product.stock === null) return Infinity;

        return Math.max(0, Math.floor(Number(product.stock)) || 0);
    }

    const getMaxQuantity = (product) => Math.min(CONFIG.maxPerItem, getStock(product));

    function limitMessage(product) {
        const stock = getStock(product);

        return stock < CONFIG.maxPerItem
            ? `Only ${stock} available in stock.`
            : "Maximum quantity reached for this item.";
    }


    /* ==========================================================
       6. LOADING PRODUCTS AND HOMEPAGE CARDS
       ========================================================== */

    function renderSkeletons(count = 8) {
        if (!el.productGrid) return;

        el.productGrid.innerHTML = Array.from({ length: count }, () => `
            <div class="skeleton-card" aria-hidden="true">
                <div class="skeleton-image"></div>
                <div class="skeleton-line"></div>
                <div class="skeleton-line short"></div>
            </div>
        `).join("");
    }

    function showGridMessage(message, className = "no-products-message") {
        if (el.productGrid) {
            el.productGrid.innerHTML = `<p class="${className}">${escapeHTML(message)}</p>`;
        }
    }

    async function loadProducts() {
        if (!el.productGrid) return;

        if (!supabaseClient) {
            showGridMessage("We could not load our collection. Please refresh the page and try again.");
            return;
        }

        renderSkeletons();

        try {
            const { data, error } = await supabaseClient
                .from("products")
                .select("id, name, category, price, old_price, description, image_url, badge, stock")
                .eq("is_active", true)
                .order("created_at", { ascending: false });

            if (error) throw error;

            state.products = (data || []).map((product) => ({
                id: String(product.id),
                name: product.name,
                category: product.category,
                price: Number(product.price),
                oldPrice: product.old_price === null ? null : Number(product.old_price),
                badge: product.badge || "",
                image: product.image_url,
                description: product.description || "",
                stock: Number(product.stock ?? 0)
            }));

            state.productsLoaded = true;

            // Drop saved bag items that no longer exist or are sold out,
            // and trim quantities to the stock that is available now.
            const cartBefore = JSON.stringify(state.cart);

            state.cart = state.cart.reduce((valid, item) => {
                const product = findProduct(item.id);
                const maxQuantity = product ? getMaxQuantity(product) : 0;

                if (maxQuantity > 0) {
                    valid.push({
                        id: product.id,
                        quantity: Math.min(item.quantity, maxQuantity)
                    });
                }

                return valid;
            }, []);

            renderProducts({ animate: true });
            renderCart();

            if (cartBefore !== JSON.stringify(state.cart)) {
                showToast("Your bag was updated to match what is currently available.", CONFIG.longToastDurationMs);
            }
        } catch (error) {
            console.error("Could not load products from Supabase:", error);

            showGridMessage("We could not load our collection. Please refresh the page and try again.");

            if (el.resultsStatus) el.resultsStatus.textContent = "Products could not be loaded.";
        }
    }

    async function loadHomepageCards() {
        if (!supabaseClient || !$("#homepage-feature-cards")) return;

        try {
            const { data, error } = await supabaseClient
                .from("homepage_feature_cards")
                .select("id, eyebrow, heading, image_url, image_alt, link_url")
                .order("id", { ascending: true });

            if (error) throw error;

            for (const card of data || []) {
                const cardElement = $(`#homepage-card-${card.id}`);

                if (!cardElement) continue;

                const image = cardElement.querySelector("img");
                const eyebrow = cardElement.querySelector(".arrival-caption span");
                const heading = cardElement.querySelector(".arrival-caption h3");

                if (image) {
                    if (isHttpsUrl(card.image_url)) {
                        const defaultSource = image.src;

                        // If the saved image cannot load, go back to the built-in one
                        image.addEventListener("error", () => {
                            if (image.src !== defaultSource) image.src = defaultSource;
                        }, { once: true });

                        image.src = card.image_url;
                    }

                    image.alt = card.image_alt || "";
                }

                if (eyebrow) eyebrow.textContent = card.eyebrow || "";
                if (heading) heading.textContent = card.heading || "";

                // Only trusted link types are applied (blocks "javascript:" links)
                if (isSafeLink(card.link_url)) cardElement.href = card.link_url.trim();
            }
        } catch (error) {
            console.error("Could not load homepage feature cards:", error);
        }
    }


    /* ==========================================================
       7. PRODUCT DISPLAY
       ========================================================== */

    function buildProductCard(product, index, animate) {
        const stock = getStock(product);
        const soldOut = stock === 0;
        const isFavourite = state.favourites.has(product.id);

        const name = escapeHTML(product.name);
        const id = escapeHTML(product.id);
        const categoryLabel = escapeHTML(CATEGORY_LABELS[product.category] || product.category);

        const oldPrice = product.oldPrice > product.price
            ? `<del><span class="visually-hidden">Previous price: </span>${formatPrice(product.oldPrice)}</del>`
            : "";

        const badge = product.badge
            ? `<span class="product-badge">${escapeHTML(product.badge)}</span>`
            : "";

        let stockNote = "";

        if (soldOut) {
            stockNote = `<p class="product-stock out-of-stock">Out of stock</p>`;
        } else if (stock <= CONFIG.lowStockThreshold) {
            stockNote = `<p class="product-stock low-stock">Only ${stock} left</p>`;
        }

        const action = soldOut
            ? `<button class="add-to-cart" type="button" disabled>Out of stock</button>`
            : `<button class="add-to-cart" type="button" data-add-to-cart="${id}">Add to bag</button>`;

        const classes = ["product-card"];
        if (soldOut) classes.push("is-sold-out");
        if (animate) classes.push("is-entering");

        const delay = animate ? `style="animation-delay: ${Math.min(index * 45, 300)}ms"` : "";

        return `
            <article class="${classes.join(" ")}" data-product-id="${id}" ${delay}>
                <div class="product-image-wrap">
                    <img class="product-image" src="${escapeHTML(safeImageUrl(product.image))}" alt="${name}" width="800" height="1000" loading="lazy">
                    ${badge}
                    <button
                        class="product-wishlist${isFavourite ? " is-favourite" : ""}"
                        type="button"
                        data-favourite="${id}"
                        aria-label="${isFavourite ? "Remove" : "Add"} ${name} ${isFavourite ? "from" : "to"} favourites"
                        aria-pressed="${isFavourite}"
                    >${isFavourite ? "♥" : "♡"}</button>
                    <div class="product-card-actions">${action}</div>
                </div>
                <div class="product-info">
                    <p class="product-category">${categoryLabel}</p>
                    <h3 class="product-name">${name}</h3>
                    <p class="product-price">${formatPrice(product.price)} ${oldPrice}</p>
                    ${stockNote}
                </div>
            </article>
        `;
    }

    function renderProducts({ animate = false } = {}) {
        if (!el.productGrid || !state.productsLoaded) return;

        const filtered = state.products.filter((product) => {
            const matchesCategory =
                state.activeFilter === "all" || product.category === state.activeFilter;

            const searchable = `${product.name} ${CATEGORY_LABELS[product.category] || product.category} ${product.description}`.toLowerCase();

            return matchesCategory && searchable.includes(state.searchTerm);
        });

        if (el.resultsStatus) {
            el.resultsStatus.textContent =
                `${filtered.length} product${filtered.length === 1 ? "" : "s"} shown`;
        }

        if (filtered.length === 0) {
            showGridMessage(
                state.products.length === 0
                    ? "New pieces are on their way. Please check back soon."
                    : "No products found. Try another search or category."
            );

            return;
        }

        el.productGrid.innerHTML = filtered
            .map((product, index) => buildProductCard(product, index, animate))
            .join("");
    }

    function setActiveFilter(filter) {
        state.activeFilter = filter;

        el.filterButtons.forEach((button) => {
            const isActive = button.dataset.filter === filter;

            button.classList.toggle("active", isActive);
            button.setAttribute("aria-pressed", String(isActive));
        });
    }

    el.filterButtons.forEach((button) => {
        button.addEventListener("click", () => {
            // A category choice starts a fresh browse, like the category cards do.
            // Otherwise an earlier search would keep filtering with no sign of it.
            state.searchTerm = "";
            if (el.searchInput) el.searchInput.value = "";

            setActiveFilter(button.dataset.filter || "all");
            renderProducts({ animate: true });
        });
    });

    document.querySelectorAll(".category-card").forEach((card) => {
        card.addEventListener("click", () => {
            const category = card.dataset.category;

            if (!category) return;

            state.searchTerm = "";
            if (el.searchInput) el.searchInput.value = "";

            setActiveFilter(category);
            renderProducts({ animate: true });
        });
    });

    // Swaps a broken product image for a branded placeholder
    el.productGrid?.addEventListener("error", handleImageError, true);
    el.cartItems?.addEventListener("error", handleImageError, true);


    /* ==========================================================
       8. FAVOURITES
       ========================================================== */

    function toggleFavourite(productId) {
        const isFavourite = !state.favourites.has(productId);

        if (isFavourite) {
            state.favourites.add(productId);
        } else {
            state.favourites.delete(productId);
        }

        writeStorage(CONFIG.favouritesStorageKey, [...state.favourites]);
        renderProducts();

        showToast(isFavourite ? "Added to your favourites." : "Removed from your favourites.");
    }


    /* ==========================================================
       9. SHOPPING BAG: STORAGE
       ========================================================== */

    function loadCart() {
        const saved = readStorage(CONFIG.cartStorageKey, []);

        if (!Array.isArray(saved)) return [];

        const valid = [];

        for (const item of saved) {
            const quantity = Number(item?.quantity);

            if (!item || item.id === undefined || !Number.isSafeInteger(quantity) || quantity <= 0) {
                continue;
            }

            const existing = valid.find((entry) => sameId(entry.id, item.id));

            if (existing) {
                existing.quantity = Math.min(CONFIG.maxPerItem, existing.quantity + quantity);
            } else {
                valid.push({
                    id: String(item.id),
                    quantity: Math.min(CONFIG.maxPerItem, quantity)
                });
            }
        }

        return valid;
    }

    function saveCart() {
        if (!writeStorage(CONFIG.cartStorageKey, state.cart)) {
            showToast("Your browser could not save the bag.");
        }
    }


    /* ==========================================================
       10. SHOPPING BAG: DISPLAY
       ========================================================== */

    const getCartCount = () =>
        state.cart.reduce((total, item) => total + item.quantity, 0);

    function getCartSubtotal() {
        return state.cart.reduce((total, item) => {
            const product = findProduct(item.id);

            return product ? total + product.price * item.quantity : total;
        }, 0);
    }

    function buildCartItem(item) {
        const product = findProduct(item.id);

        if (!product) return "";

        const name = escapeHTML(product.name);
        const id = escapeHTML(product.id);
        const atLimit = item.quantity >= getMaxQuantity(product);

        return `
            <article class="cart-item" data-cart-id="${id}">
                <img class="cart-item-image" src="${escapeHTML(safeImageUrl(product.image))}" alt="${name}" width="80" height="100">

                <div class="cart-item-details">
                    <p class="cart-item-category">${escapeHTML(CATEGORY_LABELS[product.category] || product.category)}</p>
                    <h3>${name}</h3>
                    <p class="cart-item-price">${formatPrice(product.price * item.quantity)}</p>

                    <div class="quantity-controls" role="group" aria-label="Quantity">
                        <button type="button" data-quantity-change="-1" data-product-id="${id}" aria-label="Decrease quantity of ${name}">−</button>
                        <span>${item.quantity}</span>
                        <button type="button" data-quantity-change="1" data-product-id="${id}" aria-label="Increase quantity of ${name}" ${atLimit ? "disabled" : ""}>+</button>
                    </div>
                </div>

                <button class="remove-cart-item" type="button" data-remove-product="${id}" aria-label="Remove ${name} from bag">&times;</button>
            </article>
        `;
    }

    function buildCartNotice() {
        const notice = state.cartNotice;

        if (!notice) return "";

        const link = notice.linkUrl
            ? `<a class="cart-notice-link" href="${escapeHTML(notice.linkUrl)}" target="_blank" rel="noopener">${escapeHTML(notice.linkLabel)}</a>`
            : "";

        return `
            <div class="cart-notice" role="status">
                <h3>${escapeHTML(notice.title)}</h3>
                <p>${escapeHTML(notice.text)}</p>
                ${link}
            </div>
        `;
    }

    function renderCart() {
        const itemCount = getCartCount();

        if (el.cartCount) el.cartCount.textContent = itemCount > 99 ? "99+" : itemCount;
        if (el.cartHeadingCount) el.cartHeadingCount.textContent = `(${itemCount})`;
        if (el.cartTotal) el.cartTotal.textContent = formatPrice(getCartSubtotal());

        // Checkout needs confirmed product data, so it waits for products to load
        if (el.checkoutButton) {
            el.checkoutButton.disabled = state.cart.length === 0 || !state.productsLoaded;
        }

        if (!el.cartItems) return;

        let body;

        if (state.cart.length === 0) {
            body = state.cartNotice
                ? ""
                : `<p class="empty-cart-message">Your bag is waiting for something special.</p>`;
        } else if (!state.productsLoaded) {
            body = `<p class="empty-cart-message">Loading your bag...</p>`;
        } else {
            body = state.cart.map(buildCartItem).join("");
        }

        el.cartItems.innerHTML = buildCartNotice() + body;

        saveCart();
    }


    /* ==========================================================
       11. SHOPPING BAG: ADD, CHANGE AND REMOVE
       ========================================================== */

    function addToCart(productId) {
        const product = findProduct(productId);

        if (!product) return;

        const maxQuantity = getMaxQuantity(product);

        if (maxQuantity === 0) {
            showToast("Sorry, this product is out of stock.");
            return;
        }

        const existing = state.cart.find((item) => sameId(item.id, productId));
        const currentQuantity = existing ? existing.quantity : 0;

        state.cartNotice = null;

        if (currentQuantity >= maxQuantity) {
            showToast(limitMessage(product));
            return;
        }

        if (existing) {
            existing.quantity += 1;
        } else {
            state.cart.push({ id: product.id, quantity: 1 });
        }

        renderCart();

        if (el.cartCount) {
            el.cartCount.classList.remove("is-bumping");
            void el.cartCount.offsetWidth; // restarts the CSS animation
            el.cartCount.classList.add("is-bumping");
        }

        showToast(`${product.name} added to your bag.`);
    }

    function removeFromCart(productId) {
        const item = state.cart.find((entry) => sameId(entry.id, productId));
        const product = findProduct(productId);

        state.cart = state.cart.filter((entry) => !sameId(entry.id, productId));
        renderCart();

        if (product && item) showToast(`${product.name} removed from your bag.`);
    }

    function changeQuantity(productId, amount) {
        const item = state.cart.find((entry) => sameId(entry.id, productId));

        if (!item) return;

        const nextQuantity = item.quantity + amount;

        if (nextQuantity <= 0) {
            removeFromCart(productId);
            return;
        }

        const product = findProduct(productId);

        if (!product) return;

        // Only increases are limited, so customers can always lower a quantity
        if (amount > 0 && nextQuantity > getMaxQuantity(product)) {
            showToast(limitMessage(product));
            return;
        }

        item.quantity = nextQuantity;
        renderCart();
    }

    el.productGrid?.addEventListener("click", (event) => {
        const addButton = event.target.closest("[data-add-to-cart]");

        if (addButton) {
            addToCart(addButton.dataset.addToCart);
            return;
        }

        const favouriteButton = event.target.closest("[data-favourite]");

        if (favouriteButton) toggleFavourite(favouriteButton.dataset.favourite);
    });

    el.cartItems?.addEventListener("click", (event) => {
        const quantityButton = event.target.closest("[data-quantity-change]");

        if (quantityButton) {
            changeQuantity(
                quantityButton.dataset.productId,
                Number(quantityButton.dataset.quantityChange)
            );

            return;
        }

        const removeButton = event.target.closest("[data-remove-product]");

        if (removeButton) removeFromCart(removeButton.dataset.removeProduct);
    });


    /* ==========================================================
       12. OPEN AND CLOSE PANELS
       ========================================================== */

    function openCart() {
        if (!el.cartDrawer || !el.cartOverlay) return;

        closeSearch();

        el.cartDrawer.classList.add("is-open");
        el.cartOverlay.classList.add("is-visible");
        el.cartDrawer.setAttribute("aria-hidden", "false");
        el.cartOverlay.setAttribute("aria-hidden", "false");

        document.body.classList.add("no-scroll");
        setPageInert(true);

        el.cartClose?.focus();
    }

    function closeCart() {
        // Does nothing when already closed, so Escape never steals focus
        if (!el.cartDrawer?.classList.contains("is-open")) return;

        el.cartDrawer.classList.remove("is-open");
        el.cartOverlay.classList.remove("is-visible");
        el.cartDrawer.setAttribute("aria-hidden", "true");
        el.cartOverlay.setAttribute("aria-hidden", "true");

        document.body.classList.remove("no-scroll");
        setPageInert(false);

        el.cartButton?.focus();
    }

    function openSearch() {
        if (!el.searchOverlay) return;

        closeCart();

        el.searchOverlay.classList.add("is-visible");
        el.searchOverlay.setAttribute("aria-hidden", "false");

        document.body.classList.add("no-scroll");
        setPageInert(true);

        el.searchInput?.focus();
    }

    function closeSearch() {
        if (!el.searchOverlay?.classList.contains("is-visible")) return;

        el.searchOverlay.classList.remove("is-visible");
        el.searchOverlay.setAttribute("aria-hidden", "true");

        document.body.classList.remove("no-scroll");
        setPageInert(false);

        el.searchButton?.focus();
    }

    el.cartButton?.addEventListener("click", openCart);
    el.cartClose?.addEventListener("click", closeCart);
    el.cartOverlay?.addEventListener("click", closeCart);
    el.continueShopping?.addEventListener("click", closeCart);

    el.searchButton?.addEventListener("click", openSearch);
    el.searchClose?.addEventListener("click", closeSearch);

    el.searchOverlay?.addEventListener("click", (event) => {
        if (event.target === el.searchOverlay) closeSearch();
    });


    /* ==========================================================
       13. SEARCH
       ========================================================== */

    if (el.searchForm && el.searchInput) {
        const runSearch = () => {
            state.searchTerm = el.searchInput.value.trim().toLowerCase();
            setActiveFilter("all");
            renderProducts();
        };

        el.searchInput.addEventListener("input", debounce(runSearch, CONFIG.searchDebounceMs));

        // Browsers empty a search field when Escape is pressed, without telling
        // the page. Escape here should only close the panel, so the text and
        // the filtered results stay in step.
        el.searchInput.addEventListener("keydown", (event) => {
            if (event.key === "Escape") event.preventDefault();
        });

        el.searchForm.addEventListener("submit", (event) => {
            event.preventDefault();
            runSearch();
            closeSearch();

            $("#shop")?.scrollIntoView({ behavior: "smooth" });
        });
    }


    /* ==========================================================
       14. WHATSAPP CHECKOUT
       The database creates the order and confirms prices and stock.
       The WhatsApp message is built from its response.
       ========================================================== */

    function setCheckoutBusy(busy) {
        state.isCheckingOut = busy;

        if (!el.checkoutButton) return;

        el.checkoutButton.disabled = busy || state.cart.length === 0;
        el.checkoutButton.textContent = busy ? "Placing your order..." : "Order on WhatsApp";
    }

    const buildWhatsAppUrl = (message) =>
        `https://wa.me/${CONFIG.whatsappNumber}?text=${encodeURIComponent(message)}`;

    /**
     * Turns any checkout error into a customer-safe result. Raw database or
     * network text is only ever written to the console.
     * outcome "unknown": the request may have reached the server, so the
     * order might exist. "failed": the order was not placed.
     */
    function describeCheckoutFailure(error) {
        const text = String(error?.message || "");

        if (/failed to fetch|network|load failed|timed? ?out|abort/i.test(text)) {
            return { outcome: "unknown", refresh: false };
        }

        if (/stock|available|inactive|unavailable|quantity|not found|no longer/i.test(text)) {
            return {
                outcome: "failed",
                refresh: true,
                message: "Some items in your bag are no longer available in the quantity you chose. We have updated your bag. Please review it and try again."
            };
        }

        return {
            outcome: "failed",
            refresh: false,
            message: "We couldn't place your order right now. Nothing has been charged. Please try again in a moment."
        };
    }

    /** One random key per order attempt, reused only while the same bag is retried. */
    function getCheckoutKey() {
        const signature = JSON.stringify(
            [...state.cart].sort((a, b) => a.id.localeCompare(b.id))
        );
        const saved = readStorage(CONFIG.checkoutKeyStorageKey, null);

        if (saved?.signature === signature && typeof saved.key === "string") return saved.key;

        const key = window.crypto?.randomUUID
            ? window.crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;

        writeStorage(CONFIG.checkoutKeyStorageKey, { signature, key });

        return key;
    }

    const clearCheckoutKey = () => {
        try {
            localStorage.removeItem(CONFIG.checkoutKeyStorageKey);
        } catch {
            /* nothing to clear */
        }
    };

    function buildOrderMessage(order) {
        const lines = Array.isArray(order.items)
            ? order.items.map((item) =>
                `• ${item.name}\n` +
                `  Quantity: ${item.quantity}\n` +
                `  Price: ${formatPrice(item.price * item.quantity)}`
            )
            : [];

        return [
            "Hello LUXE DISTRICT!",
            "",
            `I'd like to confirm order #${order.order_number}.`,
            "",
            ...lines,
            ...(lines.length ? [""] : []),
            `Subtotal: ${formatPrice(order.subtotal)}`,
            "",
            "Please confirm delivery fees, delivery details, and payment instructions.",
            "",
            "Thank you!"
        ].join("\n");
    }

    async function checkoutWithWhatsApp() {
        if (state.isCheckingOut) return;

        if (state.cart.length === 0) {
            showToast("Your bag is empty. Add something first.");
            return;
        }

        if (!supabaseClient) {
            showToast("We couldn't place your order. Please refresh and try again.");
            return;
        }

        if (!/^\d{10,15}$/.test(CONFIG.whatsappNumber)) {
            showToast("Ordering is not available right now. Please try again later.");
            return;
        }

        // The tab must open straight from the click, before the database request,
        // or browsers will block it as a pop-up.
        const whatsappWindow = window.open("about:blank", "_blank");

        if (!whatsappWindow) {
            showToast("Please allow pop-ups for this website and try again.");
            return;
        }

        whatsappWindow.document.title = "Preparing your order...";
        setCheckoutBusy(true);
        state.cartNotice = null;

        const payload = {
            p_items: state.cart.map((item) => ({ id: item.id, quantity: item.quantity }))
        };

        if (CONFIG.sendIdempotencyKey) payload.p_idempotency_key = getCheckoutKey();

        let order;

        try {
            const { data, error } = await supabaseClient.rpc("place_store_order", payload);

            if (error) throw error;

            if (!data?.success || !data.order_number) {
                throw new Error("The order could not be confirmed.");
            }

            order = data;
        } catch (error) {
            console.error("Checkout failed:", error);

            whatsappWindow.close();

            const failure = describeCheckoutFailure(error);

            if (failure.outcome === "unknown") {
                // The order may have been recorded even though no reply arrived.
                // Keep the bag and ask the customer to check before retrying.
                state.cartNotice = {
                    title: "We couldn't confirm your order",
                    text: "Your connection dropped, so we can't tell whether your order was received. To avoid a duplicate order, please message us on WhatsApp before trying again.",
                    linkLabel: "Message us on WhatsApp",
                    linkUrl: buildWhatsAppUrl("Hello LUXE DISTRICT! I tried to place an order but my connection dropped. Please can you check whether it was received?")
                };

                renderCart();
                showToast("We couldn't confirm your order. Please check the notice in your bag.", CONFIG.longToastDurationMs);
            } else {
                showToast(failure.message, CONFIG.longToastDurationMs);

                if (failure.refresh) loadProducts();
            }

            setCheckoutBusy(false);
            return;
        }

        // From here the order exists. Nothing below may undo that or hide it.
        clearCheckoutKey();

        const whatsappUrl = buildWhatsAppUrl(buildOrderMessage(order));

        state.cart = [];
        state.cartNotice = {
            title: `Order #${order.order_number} recorded`,
            text: "Your order has been recorded, but it is not confirmed yet. No payment has been received. Please finish the conversation on WhatsApp so we can confirm your delivery fee, delivery details and payment instructions.",
            linkLabel: "Open WhatsApp to confirm",
            linkUrl: whatsappUrl
        };

        setCheckoutBusy(false);
        renderCart();

        try {
            whatsappWindow.location.href = whatsappUrl;
        } catch (error) {
            // The notice in the bag still offers the WhatsApp link
            console.warn("Could not open WhatsApp automatically:", error);
        }

        showToast(
            `Order #${order.order_number} recorded. Please confirm payment and delivery on WhatsApp.`,
            CONFIG.longToastDurationMs
        );
    }

    el.checkoutButton?.addEventListener("click", checkoutWithWhatsApp);


    /* ==========================================================
       15. MOBILE NAVIGATION
       ========================================================== */

    function setMobileMenu(open) {
        if (!el.menuToggle || !el.mainNavigation) return;

        el.menuToggle.classList.toggle("is-open", open);
        el.mainNavigation.classList.toggle("is-open", open);
        el.menuToggle.setAttribute("aria-expanded", String(open));
        el.menuToggle.setAttribute("aria-label", open ? "Close navigation menu" : "Open navigation menu");
    }

    if (el.menuToggle && el.mainNavigation) {
        el.menuToggle.addEventListener("click", () => {
            setMobileMenu(!el.mainNavigation.classList.contains("is-open"));
        });

        el.mainNavigation.querySelectorAll("a").forEach((link) => {
            link.addEventListener("click", () => setMobileMenu(false));
        });

        window.addEventListener("resize", () => {
            if (window.innerWidth > CONFIG.mobileNavBreakpoint) setMobileMenu(false);
        });
    }


    /* ==========================================================
       16. NEWSLETTER
       No newsletter service is connected, so nothing is saved. The form is
       disabled in index.html and this handler never claims success.
       Connect a service (Mailchimp, Formspree, etc.), enable the form and
       replace this handler before launch.
       ========================================================== */

    el.newsletterForm?.addEventListener("submit", (event) => {
        event.preventDefault();
        showToast("Newsletter sign-up is not open yet. Please check back soon.");
    });


    /* ==========================================================
       17. KEYBOARD
       ========================================================== */

    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;

        closeCart();
        closeSearch();
        setMobileMenu(false);
    });


    /* ==========================================================
       18. START
       ========================================================== */

    if (el.currentYear) el.currentYear.textContent = new Date().getFullYear();

    state.cart = loadCart();
    state.favourites = new Set(
        (readStorage(CONFIG.favouritesStorageKey, []) || []).map(String)
    );

    renderCart();
    loadProducts();
    loadHomepageCards();
});