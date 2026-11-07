/**
 * LUXE DISTRICT — Admin Dashboard
 * Handles administrator login, product management (with image upload)
 * and the editable homepage feature cards, all powered by Supabase.
 *
 * SECURITY NOTE
 * The publishable key below is safe to ship in browser code ONLY because
 * Row Level Security (RLS) protects your tables and storage bucket.
 * Make sure RLS is enabled on `products`, `homepage_feature_cards`,
 * `store_admins` and on the `product-images` bucket, and that write access
 * is limited to rows in `store_admins`. The checks in this file improve the
 * experience; the database policies are what actually enforce security.
 */

document.addEventListener("DOMContentLoaded", () => {
    "use strict";

    /* ==========================================================
       1. CONFIGURATION
       ========================================================== */

    const CONFIG = Object.freeze({
        supabaseUrl: "https://qzegfwfexkneowkudatl.supabase.co",
        supabaseKey: "sb_publishable_2TF6O8Bt-FqdO3bDY4jLtw_k3Eq1-Ya",
        bucket: "product-images",
        folders: Object.freeze({
            products: "products",
            homepage: "homepage"
        }),
        maxImageSize: 5 * 1024 * 1024, // 5 MB
        allowedTypes: Object.freeze([
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/avif"
        ]),
        allowedExtensions: Object.freeze(["jpg", "jpeg", "png", "webp", "avif"]),
        homepageCardIds: Object.freeze([1, 2]),
        searchDebounceMs: 200,
        previewDebounceMs: 250
    });

    const CATEGORY_LABELS = Object.freeze({
        clothing: "Clothing",
        bags: "Bags",
        shoes: "Shoes",
        perfume: "Fragrances"
    });

    const PREVIEW_NO_IMAGE = "No image selected";
    const PREVIEW_BROKEN_IMAGE = "This image could not be loaded. Check the address.";

    const isConfigured =
        !CONFIG.supabaseUrl.startsWith("YOUR_") &&
        !CONFIG.supabaseKey.startsWith("YOUR_");

    const supabaseClient =
        window.supabase && isConfigured
            ? window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey)
            : null;


    /* ==========================================================
       2. DOM REFERENCES
       ========================================================== */

    const $ = (id) => document.getElementById(id);

    const ui = {
        loginSection: $("login-section"),
        dashboardSection: $("dashboard-section"),
        dashboardTitle: $("dashboard-title"),
        loginForm: $("login-form"),
        loginEmail: $("login-email"),
        loginPassword: $("login-password"),
        loginButton: $("login-button"),
        passwordToggle: $("password-toggle"),
        loginMessage: $("login-message"),
        logoutButton: $("logout-button"),
        dashboardMessage: $("dashboard-message"),
        adminYear: $("admin-year"),

        productForm: $("product-form"),
        productId: $("product-id"),
        productName: $("product-name"),
        productCategory: $("product-category"),
        productPrice: $("product-price"),
        productOldPrice: $("product-old-price"),
        productStock: $("product-stock"),
        productBadge: $("product-badge"),
        productImage: $("product-image"),
        productDescription: $("product-description"),
        productActive: $("product-active"),
        imagePreviewContainer: $("image-preview-container"),
        imagePreview: $("image-preview"),
        removePreviewButton: $("remove-preview-button"),
        saveProductButton: $("save-product-button"),
        editorHeading: $("editor-heading"),
        cancelEditButton: $("cancel-edit-button"),

        inventorySearch: $("inventory-search"),
        inventoryCategoryFilter: $("inventory-category-filter"),
        productCount: $("product-count"),
        inventoryLoading: $("inventory-loading"),
        inventoryEmpty: $("inventory-empty"),
        inventoryList: $("inventory-list"),

        homepageCardsForm: $("homepage-cards-form"),
        saveHomepageCardsButton: $("save-homepage-cards-button"),
        homepageCardsMessage: $("homepage-cards-message")
    };

    const cardFields = Object.fromEntries(
        CONFIG.homepageCardIds.map((id) => [
            id,
            {
                eyebrow: $(`card-${id}-eyebrow`),
                heading: $(`card-${id}-heading`),
                imageUrl: $(`card-${id}-image-url`),
                imageAlt: $(`card-${id}-image-alt`),
                linkUrl: $(`card-${id}-link-url`),
                file: $(`card-${id}-image-file`),
                preview: $(`card-${id}-image-preview`),
                removeButton: $(`card-${id}-remove-image`),
                live: {
                    frame: $(`card-${id}-live-frame`),
                    empty: $(`card-${id}-live-empty`),
                    eyebrow: $(`card-${id}-live-eyebrow`),
                    heading: $(`card-${id}-live-heading`),
                    alt: $(`card-${id}-live-alt`),
                    link: $(`card-${id}-live-link`),
                    status: $(`card-${id}-unsaved`)
                }
            }
        ])
    );


    /* ==========================================================
       3. APPLICATION STATE
       ========================================================== */

    const state = {
        products: [],
        selectedImageFile: null,
        existingImageUrl: "",
        previewObjectUrl: null,
        isSavingProduct: false,
        isSavingCards: false,
        savedCardImages: {}, // id -> image URL currently stored in the database
        savedCards: {},      // id -> text and image values as last saved (used for the "Unsaved changes" badge)
        cardObjectUrls: {}   // id -> { file, url } temporary preview address for a chosen file
    };

    if (ui.adminYear) {
        ui.adminYear.textContent = new Date().getFullYear();
    }


    /* ==========================================================
       4. GENERAL HELPERS
       ========================================================== */

    const prefersReducedMotion = () =>
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const scrollBehavior = () => (prefersReducedMotion() ? "auto" : "smooth");

    const priceFormatter = new Intl.NumberFormat("en-NG", {
        style: "currency",
        currency: "NGN",
        maximumFractionDigits: 2
    });

    const formatPrice = (price) => priceFormatter.format(Number(price) || 0);

    function debounce(callback, delay) {
        let timer;

        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => callback(...args), delay);
        };
    }

    /** Creates an element safely. Text is always inserted with textContent. */
    function createElement(tag, className, text) {
        const element = document.createElement(tag);

        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;

        return element;
    }

    function showMessage(element, message, type = "error") {
        if (!element) return;

        element.textContent = message;
        element.classList.remove("error", "success");
        element.classList.add(type);
        element.hidden = false;

        if (element === ui.dashboardMessage) {
            element.scrollIntoView({
                behavior: scrollBehavior(),
                block: "nearest"
            });
        }
    }

    function clearMessage(element) {
        if (!element) return;

        element.textContent = "";
        element.classList.remove("error", "success");
        element.hidden = true;
    }

    /** Converts technical errors into messages an administrator can act on. */
    function friendlyError(error, fallback) {
        const message = String(error?.message || "");

        if (/invalid login credentials/i.test(message)) {
            return "Incorrect email or password.";
        }

        if (/failed to fetch|networkerror|network request failed/i.test(message)) {
            return "Network problem. Check your internet connection and try again.";
        }

        if (/jwt expired|session.*(expired|missing)|refresh token/i.test(message)) {
            return "Your session has expired. Please sign in again.";
        }

        if (/row-level security|permission denied|not authorized/i.test(message)) {
            return "You do not have permission to do that. Check your Supabase policies.";
        }

        if (/foreign key|violates .* constraint/i.test(message)) {
            return "This product is linked to existing orders and cannot be deleted. Hide it from the store instead by unticking \"Make this product visible in the store\" and saving.";
        }

        return message || fallback;
    }

    function parseUrl(value) {
        try {
            return new URL(value);
        } catch {
            return null;
        }
    }

    const isHttpsUrl = (value) => parseUrl(value)?.protocol === "https:";

    /** Allows in-page anchors (#shop), site paths (/page) and HTTPS links only. */
    function isSafeLink(value) {
        if (value.startsWith("#")) return value.length > 1;
        if (value.startsWith("/")) return !value.startsWith("//");

        return isHttpsUrl(value);
    }

    function requireSupabase(messageElement) {
        if (supabaseClient) return true;

        showMessage(
            messageElement,
            "The dashboard is not connected yet. Add your Supabase URL and key at the top of admin.js."
        );

        return false;
    }


    /* ==========================================================
       5. VIEW SWITCHING
       ========================================================== */

    function showLogin() {
        setPasswordVisible(false);
        ui.loginSection.hidden = false;
        ui.dashboardSection.hidden = true;
    }

    function showDashboard() {
        setPasswordVisible(false);
        ui.loginSection.hidden = true;
        ui.dashboardSection.hidden = false;
        ui.dashboardTitle?.focus();
    }

    function resetDashboardState() {
        state.products = [];
        state.savedCardImages = {};
        state.savedCards = {};
        ui.inventoryList.innerHTML = "";
        resetHomepageCardsForm();
        resetProductForm();
        clearMessage(ui.dashboardMessage);
    }


    /* ==========================================================
       6. IMAGE VALIDATION, UPLOAD AND REMOVAL
       ========================================================== */

    /** Returns an error message, or an empty string when the file is valid. */
    function validateImageFile(file) {
        const extension = file.name.split(".").pop().toLowerCase();

        if (
            !CONFIG.allowedTypes.includes(file.type) ||
            !CONFIG.allowedExtensions.includes(extension)
        ) {
            return "Choose a JPG, PNG, WebP, or AVIF image.";
        }

        if (file.size > CONFIG.maxImageSize) {
            return `The image is too large. The maximum size is ${CONFIG.maxImageSize / (1024 * 1024)} MB.`;
        }

        return "";
    }

    function makeFileId() {
        return window.crypto?.randomUUID
            ? window.crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }

    async function uploadImage(file, folder) {
        const extension = file.name.split(".").pop().toLowerCase();
        const safeExtension = CONFIG.allowedExtensions.includes(extension)
            ? extension
            : "jpg";

        const filePath = `${folder}/${makeFileId()}.${safeExtension}`;

        const { error } = await supabaseClient.storage
            .from(CONFIG.bucket)
            .upload(filePath, file, {
                cacheControl: "31536000", // file names are unique, so long caching is safe
                upsert: false,
                contentType: file.type
            });

        if (error) throw error;

        const { data } = supabaseClient.storage
            .from(CONFIG.bucket)
            .getPublicUrl(filePath);

        return data.publicUrl;
    }

    function getStoragePath(url) {
        const marker = `/${CONFIG.bucket}/`;
        const text = String(url || "");
        const index = text.indexOf(marker);

        if (index === -1) return null;

        try {
            return decodeURIComponent(
                text.slice(index + marker.length).split("?")[0]
            );
        } catch {
            return null;
        }
    }

    /**
     * Removes an image from storage. Failures are logged but never block the
     * administrator, because a leftover file is harmless.
     * `onlyFolder` restricts removal to one folder as a safety measure.
     */
    async function removeStoredImage(url, onlyFolder = null) {
        const path = getStoragePath(url);

        if (!path) return;
        if (onlyFolder && !path.startsWith(`${onlyFolder}/`)) return;

        try {
            const { error } = await supabaseClient.storage
                .from(CONFIG.bucket)
                .remove([path]);

            if (error) console.warn("Could not remove the image:", error);
        } catch (error) {
            console.warn("Could not remove the image:", error);
        }
    }


    /* ==========================================================
       7. AUTHENTICATION
       ========================================================== */

    async function verifyAdmin() {
        const {
            data: { user },
            error: authError
        } = await supabaseClient.auth.getUser();

        if (authError || !user) return false;

        const { data, error } = await supabaseClient
            .from("store_admins")
            .select("user_id")
            .eq("user_id", user.id)
            .maybeSingle();

        if (error) {
            console.error("Administrator verification failed:", error);

            throw new Error(
                "Unable to verify administrator access. Check your Supabase policies."
            );
        }

        return Boolean(data);
    }

    async function openDashboard() {
        showDashboard();

        // The two sections are independent, so one failing must not block the other.
        await Promise.allSettled([loadProducts(), loadHomepageCards()]);
    }

    async function initializeApp() {
        showLogin();
        clearMessage(ui.loginMessage);

        if (!requireSupabase(ui.loginMessage)) return;

        try {
            const {
                data: { session },
                error
            } = await supabaseClient.auth.getSession();

            if (error) throw error;
            if (!session) return;

            if (!(await verifyAdmin())) {
                await supabaseClient.auth.signOut();

                showMessage(
                    ui.loginMessage,
                    "This account is not authorized to access the admin dashboard."
                );

                return;
            }

            await openDashboard();
        } catch (error) {
            console.error("Initialization error:", error);

            showLogin();
            showMessage(
                ui.loginMessage,
                friendlyError(error, "Unable to initialize the dashboard.")
            );
        }
    }

    ui.loginForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        clearMessage(ui.loginMessage);

        if (!requireSupabase(ui.loginMessage)) return;
        if (ui.loginButton.disabled) return;

        ui.loginButton.disabled = true;
        ui.loginButton.textContent = "Signing In...";

        try {
            const { error } = await supabaseClient.auth.signInWithPassword({
                email: ui.loginEmail.value.trim(),
                password: ui.loginPassword.value
            });

            if (error) throw error;

            if (!(await verifyAdmin())) {
                await supabaseClient.auth.signOut();

                throw new Error(
                    "Access denied. This account is not registered as a store administrator."
                );
            }

            ui.loginForm.reset();
            await openDashboard();
        } catch (error) {
            console.error("Login error:", error);

            showMessage(
                ui.loginMessage,
                friendlyError(error, "Login failed. Please try again.")
            );
        } finally {
            ui.loginButton.disabled = false;
            ui.loginButton.textContent = "Sign In";
        }
    });

    ui.logoutButton.addEventListener("click", async () => {
        ui.logoutButton.disabled = true;

        try {
            const { error } = await supabaseClient.auth.signOut();

            if (error) throw error;

            resetDashboardState();
            showLogin();
            clearMessage(ui.loginMessage);
            ui.loginEmail.focus();
        } catch (error) {
            console.error("Logout error:", error);

            showMessage(
                ui.dashboardMessage,
                "Unable to sign out. Please try again."
            );
        } finally {
            ui.logoutButton.disabled = false;
        }
    });

    // Keeps the interface correct if the session ends elsewhere or expires.
    // This callback stays synchronous on purpose: awaiting Supabase calls
    // inside it can cause deadlocks.
    if (supabaseClient) {
        supabaseClient.auth.onAuthStateChange((event, session) => {
            if (event !== "SIGNED_OUT" && session) return;

            const wasInDashboard = !ui.dashboardSection.hidden;

            resetDashboardState();
            showLogin();

            if (wasInDashboard) {
                showMessage(
                    ui.loginMessage,
                    "You have been signed out. Please sign in again."
                );
            }
        });
    }


    /* ==========================================================
       8. PRODUCTS: LOAD AND DISPLAY
       ========================================================== */

    async function loadProducts() {
        ui.inventoryLoading.hidden = false;
        ui.inventoryEmpty.hidden = true;
        ui.inventoryList.innerHTML = "";

        try {
            const { data, error } = await supabaseClient
                .from("products")
                .select("*")
                .order("created_at", { ascending: false });

            if (error) throw error;

            state.products = data || [];
            renderProducts();
        } catch (error) {
            console.error("Product loading error:", error);

            showMessage(
                ui.dashboardMessage,
                friendlyError(error, "Unable to load products. Check your database permissions.")
            );
        } finally {
            ui.inventoryLoading.hidden = true;
        }
    }

    function buildProductItem(product) {
        const isActive = Boolean(product.is_active);
        const inStock = Number(product.stock) > 0;
        const name = String(product.name ?? "");
        const categoryLabel = CATEGORY_LABELS[product.category] || product.category;

        const item = createElement("article", "inventory-item");

        const image = createElement("img", "inventory-item-image");
        image.src = product.image_url || "";
        image.alt = name;
        image.loading = "lazy";
        image.addEventListener("error", () => {
            image.alt = "Product image unavailable";
            image.removeAttribute("src");
        });

        const content = createElement("div", "inventory-item-content");

        const status = createElement(
            "p",
            `inventory-item-status ${isActive ? "is-active" : "is-inactive"}`,
            isActive ? "Visible in store" : "Hidden from store"
        );

        const actions = createElement("div", "inventory-item-actions");

        const editButton = createElement("button", "", "Edit");
        editButton.type = "button";
        editButton.dataset.editProduct = product.id;
        editButton.setAttribute("aria-label", `Edit ${name}`);

        const deleteButton = createElement("button", "delete-product-button", "Delete");
        deleteButton.type = "button";
        deleteButton.dataset.deleteProduct = product.id;
        deleteButton.setAttribute("aria-label", `Delete ${name}`);

        actions.append(editButton, deleteButton);

        content.append(
            createElement("p", "inventory-item-category", categoryLabel),
            createElement("h3", "inventory-item-name", name),
            createElement("p", "inventory-item-price", formatPrice(product.price)),
            createElement(
                "p",
                "inventory-item-stock",
                inStock ? `${product.stock} in stock` : "Out of stock"
            ),
            status,
            actions
        );

        item.append(image, content);

        return item;
    }

    function renderProducts() {
        const searchTerm = ui.inventorySearch.value.trim().toLowerCase();
        const selectedCategory = ui.inventoryCategoryFilter.value;

        const filtered = state.products.filter((product) => {
            const matchesSearch =
                String(product.name).toLowerCase().includes(searchTerm) ||
                String(product.category).toLowerCase().includes(searchTerm);

            const matchesCategory =
                selectedCategory === "all" || product.category === selectedCategory;

            return matchesSearch && matchesCategory;
        });

        ui.productCount.textContent =
            `${filtered.length} product${filtered.length === 1 ? "" : "s"}`;

        ui.inventoryList.replaceChildren();

        if (filtered.length === 0) {
            ui.inventoryEmpty.hidden = false;
            ui.inventoryEmpty.textContent =
                state.products.length === 0
                    ? "No products yet. Add your first product using the form."
                    : "No products match your search.";

            return;
        }

        ui.inventoryEmpty.hidden = true;

        const fragment = document.createDocumentFragment();
        filtered.forEach((product) => fragment.appendChild(buildProductItem(product)));
        ui.inventoryList.appendChild(fragment);
    }

    ui.inventorySearch.addEventListener(
        "input",
        debounce(renderProducts, CONFIG.searchDebounceMs)
    );
    ui.inventoryCategoryFilter.addEventListener("change", renderProducts);


    /* ==========================================================
       9. PRODUCTS: IMAGE PREVIEW
       ========================================================== */

    function refreshPreview() {
        const source = state.previewObjectUrl || state.existingImageUrl;

        if (source) {
            ui.imagePreview.src = source;
            ui.imagePreviewContainer.hidden = false;
        } else {
            ui.imagePreview.removeAttribute("src");
            ui.imagePreviewContainer.hidden = true;
        }

        ui.removePreviewButton.hidden = !state.selectedImageFile;
    }

    function clearSelectedImage() {
        state.selectedImageFile = null;

        if (state.previewObjectUrl) {
            URL.revokeObjectURL(state.previewObjectUrl);
            state.previewObjectUrl = null;
        }

        ui.productImage.value = "";
        refreshPreview();
    }

    ui.productImage.addEventListener("change", () => {
        clearMessage(ui.dashboardMessage);

        const file = ui.productImage.files[0];

        if (!file) {
            clearSelectedImage();
            return;
        }

        const problem = validateImageFile(file);

        if (problem) {
            clearSelectedImage();
            showMessage(ui.dashboardMessage, problem);
            return;
        }

        if (state.previewObjectUrl) {
            URL.revokeObjectURL(state.previewObjectUrl);
        }

        state.selectedImageFile = file;
        state.previewObjectUrl = URL.createObjectURL(file);

        refreshPreview();
    });

    ui.removePreviewButton.addEventListener("click", () => {
        clearSelectedImage();
        clearMessage(ui.dashboardMessage);
    });


    /* ==========================================================
       10. PRODUCTS: SAVE
       ========================================================== */

    function setSavingState(saving) {
        state.isSavingProduct = saving;
        ui.saveProductButton.disabled = saving;

        ui.saveProductButton.textContent = saving
            ? "Saving Product..."
            : ui.productId.value
                ? "Update Product"
                : "Save Product";
    }

    function readProductForm() {
        const data = {
            name: ui.productName.value.trim(),
            category: ui.productCategory.value,
            price: Number(ui.productPrice.value),
            old_price: ui.productOldPrice.value
                ? Number(ui.productOldPrice.value)
                : null,
            description: ui.productDescription.value.trim(),
            badge: ui.productBadge.value || null,
            stock: Number(ui.productStock.value),
            is_active: ui.productActive.checked,
            updated_at: new Date().toISOString()
        };

        if (!data.name) return { error: "Enter the product name." };
        if (!data.category) return { error: "Choose a category." };
        if (!data.description) return { error: "Enter a product description." };

        if (!Number.isFinite(data.price) || data.price < 0) {
            return { error: "Enter a valid selling price." };
        }

        if (!Number.isInteger(data.stock) || data.stock < 0) {
            return { error: "Stock must be a whole number of 0 or more." };
        }

        if (data.old_price !== null) {
            if (!Number.isFinite(data.old_price) || data.old_price < 0) {
                return { error: "Enter a valid previous price." };
            }

            if (data.old_price <= data.price) {
                return {
                    error: "The previous price should be higher than the selling price."
                };
            }
        }

        return { data };
    }

    ui.productForm.addEventListener("submit", async (event) => {
        event.preventDefault();

        if (state.isSavingProduct) return;

        clearMessage(ui.dashboardMessage);

        const editing = Boolean(ui.productId.value);

        if (!editing && !state.selectedImageFile) {
            showMessage(ui.dashboardMessage, "Please select an image for your new product.");
            return;
        }

        const { data: productData, error: formError } = readProductForm();

        if (formError) {
            showMessage(ui.dashboardMessage, formError);
            return;
        }

        const previousImageUrl = state.existingImageUrl;
        let uploadedImageUrl = "";

        setSavingState(true);

        try {
            if (state.selectedImageFile) {
                uploadedImageUrl = await uploadImage(
                    state.selectedImageFile,
                    CONFIG.folders.products
                );
            }

            productData.image_url = uploadedImageUrl || previousImageUrl;

            if (!productData.image_url) {
                throw new Error("Please select a product image.");
            }

            const table = supabaseClient.from("products");

            const { error } = editing
                ? await table.update(productData).eq("id", ui.productId.value)
                : await table.insert(productData);

            if (error) throw error;

            // The product is saved, so the replaced image is no longer needed.
            if (editing && uploadedImageUrl && previousImageUrl) {
                await removeStoredImage(previousImageUrl);
            }

            showMessage(
                ui.dashboardMessage,
                editing ? "Product updated successfully!" : "Product added successfully!",
                "success"
            );

            resetProductForm();
            await loadProducts();
        } catch (error) {
            console.error("Saving product failed:", error);

            // Do not leave an orphaned upload behind if the save failed.
            if (uploadedImageUrl) await removeStoredImage(uploadedImageUrl);

            showMessage(
                ui.dashboardMessage,
                friendlyError(error, "Unable to save the product.")
            );
        } finally {
            setSavingState(false);
        }
    });


    /* ==========================================================
       11. PRODUCTS: EDIT, DELETE AND RESET
       ========================================================== */

    const findProduct = (id) =>
        state.products.find((item) => String(item.id) === String(id));

    function editProduct(id) {
        const product = findProduct(id);

        if (!product) {
            showMessage(ui.dashboardMessage, "The selected product could not be found.");
            return;
        }

        ui.productId.value = product.id;
        ui.productName.value = product.name;
        ui.productCategory.value = product.category;
        ui.productPrice.value = product.price;
        ui.productOldPrice.value = product.old_price ?? "";
        ui.productStock.value = product.stock;
        ui.productBadge.value = product.badge ?? "";
        ui.productDescription.value = product.description ?? "";
        ui.productActive.checked = Boolean(product.is_active);

        state.existingImageUrl = product.image_url || "";
        clearSelectedImage();

        ui.editorHeading.textContent = "Edit product";
        ui.saveProductButton.textContent = "Update Product";
        ui.cancelEditButton.hidden = false;

        clearMessage(ui.dashboardMessage);

        ui.productForm.scrollIntoView({
            behavior: scrollBehavior(),
            block: "start"
        });

        ui.productName.focus({ preventScroll: true });
    }

    async function deleteProduct(id, button) {
        const product = findProduct(id);

        if (!product) return;

        const confirmed = window.confirm(
            `Are you sure you want to delete "${product.name}"? This action cannot be undone.`
        );

        if (!confirmed) return;

        clearMessage(ui.dashboardMessage);

        if (button) button.disabled = true;

        try {
            const { error } = await supabaseClient
                .from("products")
                .delete()
                .eq("id", product.id);

            if (error) throw error;

            await removeStoredImage(product.image_url);

            showMessage(
                ui.dashboardMessage,
                `"${product.name}" was deleted successfully.`,
                "success"
            );

            if (String(ui.productId.value) === String(product.id)) {
                resetProductForm();
            }

            await loadProducts();
        } catch (error) {
            console.error("Product deletion failed:", error);

            if (button) button.disabled = false;

            showMessage(
                ui.dashboardMessage,
                friendlyError(error, "Unable to delete the product.")
            );
        }
    }

    ui.inventoryList.addEventListener("click", (event) => {
        const editButton = event.target.closest("[data-edit-product]");
        const deleteButton = event.target.closest("[data-delete-product]");

        if (editButton) {
            editProduct(editButton.dataset.editProduct);
        } else if (deleteButton) {
            deleteProduct(deleteButton.dataset.deleteProduct, deleteButton);
        }
    });

    function resetProductForm() {
        ui.productForm.reset();
        ui.productId.value = "";
        state.existingImageUrl = "";

        clearSelectedImage();

        ui.editorHeading.textContent = "Add a new product";
        ui.saveProductButton.textContent = "Save Product";
        ui.cancelEditButton.hidden = true;
    }

    ui.cancelEditButton.addEventListener("click", () => {
        resetProductForm();
        clearMessage(ui.dashboardMessage);
    });


    /* ==========================================================
       12. HOMEPAGE CARDS: LOAD
       ========================================================== */

    async function loadHomepageCards() {
        clearMessage(ui.homepageCardsMessage);

        try {
            const { data, error } = await supabaseClient
                .from("homepage_feature_cards")
                .select("id, eyebrow, heading, image_url, image_alt, link_url")
                .order("id", { ascending: true });

            if (error) throw error;

            for (const card of data || []) {
                const fields = cardFields[card.id];

                if (!fields) continue;

                fields.eyebrow.value = card.eyebrow || "";
                fields.heading.value = card.heading || "";
                fields.imageUrl.value = card.image_url || "";
                fields.imageAlt.value = card.image_alt || "";
                fields.linkUrl.value = card.link_url || "#shop";

                state.savedCardImages[card.id] = card.image_url || "";
                state.savedCards[card.id] = readCardValues(card.id);
            }

            // Cards with no database row yet start from the form's own defaults
            for (const id of CONFIG.homepageCardIds) {
                state.savedCards[id] ??= readCardValues(id);
                refreshCardPreview(id);
            }
        } catch (error) {
            console.error("Homepage cards loading error:", error);

            showMessage(
                ui.homepageCardsMessage,
                friendlyError(error, "Unable to load homepage cards. Check your database permissions.")
            );
        }
    }


    /* ==========================================================
       13. HOMEPAGE CARDS: LIVE PREVIEW
       Everything in this section only changes the admin page.
       The storefront changes only after "Save Homepage Cards"
       succeeds (see section 14).
       ========================================================== */

    /** Reads what is currently typed into one card's form fields. */
    function readCardValues(id) {
        const fields = cardFields[id];

        return {
            eyebrow: fields.eyebrow.value.trim(),
            heading: fields.heading.value.trim(),
            image_url: fields.imageUrl.value.trim(),
            image_alt: fields.imageAlt.value.trim(),
            link_url: fields.linkUrl.value.trim()
        };
    }

    function setLiveText(element, value, placeholder) {
        if (!element) return;

        element.textContent = value || placeholder;
        element.classList.toggle("is-placeholder", !value);
    }

    /** Updates the text parts of the preview. Runs on every keystroke. */
    function renderCardText(id) {
        const { live, preview } = cardFields[id];

        if (!live.frame) return;

        const values = readCardValues(id);

        setLiveText(live.eyebrow, values.eyebrow, "Eyebrow text");
        setLiveText(live.heading, values.heading, "Heading");
        setLiveText(live.alt, values.image_alt, "No description yet");

        if (preview) {
            preview.alt = values.image_alt || "Preview of the homepage card image";
        }

        const linkInvalid = Boolean(values.link_url) && !isSafeLink(values.link_url);

        setLiveText(
            live.link,
            linkInvalid ? `${values.link_url} (not a valid link)` : values.link_url,
            "No link yet"
        );

        live.link?.classList.toggle("is-invalid", linkInvalid);
    }

    /**
     * Decides which image the preview shows.
     * An uploaded file wins over a pasted address, exactly as when saving.
     */
    function getCardPreviewSource(id) {
        const { file, imageUrl } = cardFields[id];
        const selected = file?.files?.[0];
        const stored = state.cardObjectUrls[id];

        if (selected) {
            if (stored?.file === selected) return stored.url;

            if (stored) URL.revokeObjectURL(stored.url);

            const url = URL.createObjectURL(selected);
            state.cardObjectUrls[id] = { file: selected, url };

            return url;
        }

        // No file is chosen any more, so release the temporary address
        if (stored) {
            URL.revokeObjectURL(stored.url);
            delete state.cardObjectUrls[id];
        }

        const typed = imageUrl.value.trim();

        return isHttpsUrl(typed) ? typed : "";
    }

    /** Updates the preview image. Does nothing if the image has not changed. */
    function renderCardImage(id) {
        const { preview, live, file, removeButton } = cardFields[id];

        if (!preview || !live.frame) return;

        // "Remove Selected Image" only makes sense while a file is chosen
        if (removeButton) removeButton.hidden = !file?.files?.length;

        const source = getCardPreviewSource(id);

        if (preview.dataset.source === source) return;

        preview.dataset.source = source;

        const showEmpty = (message) => {
            preview.hidden = true;
            preview.removeAttribute("src");
            live.frame.classList.add("is-empty");

            if (live.empty) live.empty.textContent = message;
        };

        if (!source) {
            showEmpty(PREVIEW_NO_IMAGE);
            return;
        }

        // Ignore results from an older image if the source changed meanwhile
        preview.onload = () => {
            if (preview.dataset.source !== source) return;

            live.frame.classList.remove("is-empty");
            preview.hidden = false;
        };

        preview.onerror = () => {
            if (preview.dataset.source !== source) return;

            showEmpty(PREVIEW_BROKEN_IMAGE);
        };

        preview.src = source;
    }

    /** Shows "Unsaved changes" when the card differs from what is saved. */
    function updateCardDirty(id) {
        const { live, file } = cardFields[id];
        const saved = state.savedCards[id];

        if (!live.status) return;

        const current = readCardValues(id);

        const changed =
            Boolean(saved) &&
            (Boolean(file?.files?.length) ||
                Object.keys(current).some((key) => current[key] !== saved[key]));

        live.status.hidden = !changed;
    }

    function refreshCardPreview(id) {
        renderCardText(id);
        renderCardImage(id);
        updateCardDirty(id);
    }

    /** Clears the cards form (used on sign-out) and redraws the previews. */
    function resetHomepageCardsForm() {
        ui.homepageCardsForm?.reset();
        clearMessage(ui.homepageCardsMessage);

        CONFIG.homepageCardIds.forEach(refreshCardPreview);
    }

    for (const id of CONFIG.homepageCardIds) {
        const fields = cardFields[id];
        const { file: fileInput, imageUrl: urlInput, removeButton, preview } = fields;

        if (!fileInput || !urlInput || !preview) continue;

        const renderImageSoon = debounce(() => renderCardImage(id), CONFIG.previewDebounceMs);

        // Text fields update the preview immediately
        for (const input of [fields.eyebrow, fields.heading, fields.imageAlt, fields.linkUrl]) {
            input?.addEventListener("input", () => {
                renderCardText(id);
                updateCardDirty(id);
            });
        }

        // The image address updates the text at once and the picture a moment
        // later, so half-typed addresses do not trigger many failed loads
        urlInput.addEventListener("input", () => {
            updateCardDirty(id);
            renderImageSoon();
        });

        // An uploaded file shows in the preview straight away
        fileInput.addEventListener("change", () => {
            const selected = fileInput.files?.[0];

            if (selected) {
                const problem = validateImageFile(selected);

                if (problem) {
                    fileInput.value = "";
                    showMessage(ui.homepageCardsMessage, problem);
                } else {
                    clearMessage(ui.homepageCardsMessage);
                }
            }

            renderCardImage(id);
            updateCardDirty(id);
        });

        // Removing the chosen file falls back to the pasted address, if any
        removeButton?.addEventListener("click", () => {
            fileInput.value = "";

            renderCardImage(id);
            updateCardDirty(id);
            clearMessage(ui.homepageCardsMessage);
        });

        refreshCardPreview(id);
    }


    /* ==========================================================
       14. HOMEPAGE CARDS: SAVE
       ========================================================== */

    function setCardsSavingState(saving) {
        state.isSavingCards = saving;
        ui.saveHomepageCardsButton.disabled = saving;
        ui.saveHomepageCardsButton.textContent = saving
            ? "Saving..."
            : "Save Homepage Cards";
    }

    /** Validates one card and uploads its image if a new file was chosen. */
    async function buildCard(id, uploadedUrls) {
        const fields = cardFields[id];
        const file = fields.file?.files?.[0];

        let imageUrl = fields.imageUrl.value.trim();

        if (file) {
            const problem = validateImageFile(file);

            if (problem) throw new Error(`Card ${id}: ${problem}`);

            imageUrl = await uploadImage(file, CONFIG.folders.homepage);
            uploadedUrls.push(imageUrl);
        }

        const card = {
            id,
            eyebrow: fields.eyebrow.value.trim(),
            heading: fields.heading.value.trim(),
            image_url: imageUrl,
            image_alt: fields.imageAlt.value.trim(),
            link_url: fields.linkUrl.value.trim(),
            updated_at: new Date().toISOString()
        };

        if (
            !card.eyebrow ||
            !card.heading ||
            !card.image_url ||
            !card.image_alt ||
            !card.link_url
        ) {
            throw new Error(`Please complete every field for card ${id}.`);
        }

        if (!isHttpsUrl(card.image_url)) {
            throw new Error(
                `Card ${id}: enter a valid HTTPS image URL or upload an image.`
            );
        }

        if (!isSafeLink(card.link_url)) {
            throw new Error(
                `Card ${id}: the link must be a section like #shop, a site path like /about, or an HTTPS address.`
            );
        }

        return card;
    }

    ui.homepageCardsForm?.addEventListener("submit", async (event) => {
        event.preventDefault();

        if (!requireSupabase(ui.homepageCardsMessage)) return;
        if (state.isSavingCards) return;

        clearMessage(ui.homepageCardsMessage);
        setCardsSavingState(true);

        const uploadedUrls = [];

        try {
            const cards = [];

            // Sequential on purpose: if card 2 is invalid, nothing else is saved.
            for (const id of CONFIG.homepageCardIds) {
                cards.push(await buildCard(id, uploadedUrls));
            }

            const { error } = await supabaseClient
                .from("homepage_feature_cards")
                .upsert(cards, { onConflict: "id" });

            if (error) throw error;

            // Saved: reflect the final values and clean up replaced uploads.
            for (const card of cards) {
                const fields = cardFields[card.id];
                const oldUrl = state.savedCardImages[card.id];

                fields.imageUrl.value = card.image_url;
                if (fields.file) fields.file.value = "";
                state.savedCards[card.id] = readCardValues(card.id);
                refreshCardPreview(card.id);

                if (oldUrl && oldUrl !== card.image_url) {
                    // Restricted to the homepage folder so a product photo
                    // can never be deleted by mistake.
                    await removeStoredImage(oldUrl, CONFIG.folders.homepage);
                }

                state.savedCardImages[card.id] = card.image_url;
            }

            showMessage(
                ui.homepageCardsMessage,
                "Homepage cards saved successfully.",
                "success"
            );
        } catch (error) {
            console.error("Homepage cards save error:", error);

            // Remove uploads from this attempt, since nothing was saved.
            await Promise.all(uploadedUrls.map((url) => removeStoredImage(url)));

            showMessage(
                ui.homepageCardsMessage,
                friendlyError(error, "Unable to save homepage cards.")
            );
        } finally {
            setCardsSavingState(false);
        }
    });


    /* ==========================================================
       15. START
       ========================================================== */

    /* ==========================================================
       14b. PASSWORD SHOW / HIDE
       Only switches the input type. The value, the form and the
       sign-in request are never touched. The password is hidden
       again whenever the login screen or dashboard is shown.
       ========================================================== */

    function setPasswordVisible(visible) {
        if (!ui.passwordToggle || !ui.loginPassword) return;

        ui.loginPassword.type = visible ? "text" : "password";
        ui.passwordToggle.setAttribute("aria-pressed", String(visible));
        ui.passwordToggle.setAttribute("aria-label", visible ? "Hide password" : "Show password");
        // SVG elements have no .hidden property, so toggle the attribute itself
        ui.passwordToggle.querySelector(".icon-eye").toggleAttribute("hidden", visible);
        ui.passwordToggle.querySelector(".icon-eye-off").toggleAttribute("hidden", !visible);
    }

    ui.passwordToggle?.addEventListener("click", () => {
        setPasswordVisible(ui.loginPassword.type === "password");
    });

    initializeApp();
});