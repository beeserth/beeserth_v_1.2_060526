const DEFAULT_ORDER_API_URL = 'https://script.google.com/macros/s/AKfycbz3PB8qM0rUz6ExQxpkTo9aiJ0aLKZvzxsNZ3Xgs61ZAEq3JkYJnerY4Awa6tCqTpFTXg/exec';
const ORDER_API_URL = window.BEESERTH_ORDER_API || DEFAULT_ORDER_API_URL;
const CART_STORAGE_KEY = 'beeserth_cart';
const CHECKOUT_STORAGE_KEY = 'beeserth_checkout_draft';
const ORDER_ID_STORAGE_KEY = 'beeserth_order_ids';
const ORDER_SAVE_TIMEOUT_MS = 15000;
const WHATSAPP_REDIRECT_DELAY_MS = 150;
const PRODUCT_CATALOG = {
    'Lemon Bio Enzyme Floor Cleaner': {
        image: 'assets/images/products/floor-cleaner.jpeg',
        unitPrice: 205,
        unitLabel: '750ml'
    },
    'Lemon Bio-Enzyme Dishwash': {
        image: 'assets/images/products/dishwash.png'
    },
    'Bio Washing Machine Liquid': {
        image: 'assets/images/products/washing-machine-liquid.png'
    },
    'Lemon and Soapnut Bio-Enzyme Toilet Cleaner': {
        image: 'assets/images/products/toilet-cleaner.png'
    },
    'Soapnut and Shikakai Shampoo': {
        image: 'assets/images/products/shampoo.png'
    }
};
const PRODUCT_IMAGE_MAP = Object.fromEntries(
    Object.entries(PRODUCT_CATALOG).map(([name, config]) => [name, config.image])
);

let cart = [];
let pendingOrder = null;
let pendingNotifyItem = '';

function getIndianTimestampParts(date = new Date()) {
    const formatter = new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });

    return formatter.formatToParts(date).reduce((acc, part) => {
        if (part.type !== 'literal') acc[part.type] = part.value;
        return acc;
    }, {});
}

function getOrderTimestamp() {
    const parts = getIndianTimestampParts(new Date());
    return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second} IST`;
}

function generateOrderId() {
    const usedIds = JSON.parse(localStorage.getItem(ORDER_ID_STORAGE_KEY) || '[]');
    let orderId = '';

    do {
        orderId = String(Math.floor(100000000000 + Math.random() * 900000000000));
    } while (usedIds.includes(orderId));

    usedIds.push(orderId);
    localStorage.setItem(ORDER_ID_STORAGE_KEY, JSON.stringify(usedIds.slice(-500)));
    return orderId;
}

function formatMoney(amount, options = {}) {
    const numericAmount = Number(amount) || 0;
    const formatter = new Intl.NumberFormat('en-IN', {
        minimumFractionDigits: options.minimumFractionDigits ?? 2,
        maximumFractionDigits: options.maximumFractionDigits ?? 2
    });
    return formatter.format(numericAmount);
}

function getProductConfig(name, fallbackPrice = 0, fallbackImage = '') {
    const productConfig = PRODUCT_CATALOG[name] || {};
    return {
        name,
        image: productConfig.image || fallbackImage,
        price: productConfig.unitPrice ?? fallbackPrice,
        originalPrice: productConfig.originalPrice ?? 0,
        discountPct: productConfig.discountPct ?? 0,
        unitLabel: productConfig.unitLabel || ''
    };
}

function calculateCartPricing(items = cart) {
    const subtotal = items.reduce((sum, item) => sum + ((Number(item.price) || 0) * item.qty), 0);
    const totalQty = items.reduce((sum, item) => sum + item.qty, 0);
    const grandTotal = subtotal;

    return { subtotal, totalQty, grandTotal };
}

function formatUnitPriceLabel(amount) {
    return `${formatMoney(amount, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}/-`;
}

function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    })[char]);
}

function buildCheckoutDetails(orderData) {
    return [
        `${orderData.name}`,
        `${orderData.phone}`,
        orderData.altPhone || 'N/A',
        orderData.mail || 'N/A',
        orderData.address,
        orderData.state,
        orderData.pin,
        orderData.landmark || 'N/A'
    ];
}

function buildWhatsAppMessage(orderData) {
    const itemLines = cart
        .map((item) => {
            const sizeLabel = item.unitLabel ? ` | ${item.unitLabel}` : '';
            return `- ${item.name}${sizeLabel} x ${item.qty} | Rs ${formatMoney(item.price * item.qty)}`;
        })
        .join('\n');

    const addressLines = [
        orderData.address,
        orderData.state,
        orderData.pin,
        orderData.landmark ? `Landmark: ${orderData.landmark}` : ''
    ].filter(Boolean).join(', ');

    const optionalLines = [
        orderData.mail ? `Email: ${orderData.mail}` : '',
        orderData.altPhone ? `Alternate Number: ${orderData.altPhone}` : ''
    ].filter(Boolean).join('\n');

    return [
        'Order from Beesr erth.',
        `${orderData.orderId}`,
        '',
        `${orderData.name}`,
        `${orderData.phone}`,
        '',
        'Items:',
        itemLines,
        '',
        `Total: Rs ${orderData.grandTotal}`,
        '',
        'Address:',
        addressLines,
        optionalLines ? `\n${optionalLines}` : ''
    ].join('\n').trim();
}

function buildSheetPayload(orderData) {
    return {
        requestType: 'order',
        'Saved At': orderData.orderTimestamp,
        'Order ID': orderData.orderId,
        'Customer Name': orderData.name,
        'Phone': orderData.phone,
        'Alternate Number': orderData.altPhone || '',
        'Email': orderData.mail || '',
        'Address': orderData.address,
        'State': orderData.state,
        'Pin Code': orderData.pin,
        'Landmark': orderData.landmark || '',
        'Items': orderData.orderItemsLines,
        'Product Cost': orderData.subtotal,
        'Total Bottles': orderData.quantity,
        'Total': orderData.grandTotal
    };
}

function buildNotifyPayload() {
    return {
        requestType: 'notify',
        'Saved At': getOrderTimestamp(),
        'Item Name': pendingNotifyItem,
        'Customer Name': document.getElementById('notifyName').value.trim(),
        'Phone': document.getElementById('notifyPhone').value.trim(),
        'Email': document.getElementById('notifyEmail').value.trim(),
        'Address': document.getElementById('notifyAddress').value.trim(),
        'State': document.getElementById('notifyState').value.trim(),
        'Pin Code': document.getElementById('notifyPin').value.trim()
    };
}

function buildNotifyWhatsAppMessage(notifyData) {
    return [
        'Notify me request from Beesr erth.',
        '',
        `Item: ${notifyData['Item Name']}`,
        `Name: ${notifyData['Customer Name']}`,
        `WhatsApp: ${notifyData['Phone']}`,
        notifyData['Email'] ? `Email: ${notifyData['Email']}` : '',
        `Address: ${notifyData['Address']}`,
        `State: ${notifyData['State']}`,
        `Pincode: ${notifyData['Pin Code']}`,
        `Requested At: ${notifyData['Saved At']}`
    ].filter(Boolean).join('\n');
}

function redirectToWhatsApp(message) {
    const targetUrl = `https://wa.me/918375003180?text=${encodeURIComponent(message)}`;
    window.location.href = targetUrl;
}

function saveSheetRequest(payload, successErrorMessage) {
    return new Promise((resolve, reject) => {
        if (!ORDER_API_URL) {
            reject(new Error('Sheet endpoint is not configured yet.'));
            return;
        }

        const callbackName = `beeserthSheetSave_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
        const script = document.createElement('script');
        const cleanup = () => {
            delete window[callbackName];
            script.remove();
            clearTimeout(timeoutId);
        };
        const timeoutId = window.setTimeout(() => {
            cleanup();
            reject(new Error(successErrorMessage));
        }, ORDER_SAVE_TIMEOUT_MS);

        window[callbackName] = (response) => {
            cleanup();
            if (response && response.ok) {
                resolve(response);
                return;
            }

            reject(new Error(response && response.error ? response.error : successErrorMessage));
        };

        script.src = `${ORDER_API_URL}?${new URLSearchParams({ ...payload, callback: callbackName }).toString()}`;
        script.async = true;
        script.onerror = () => {
            cleanup();
            reject(new Error(successErrorMessage));
        };

        document.body.appendChild(script);
    });
}

function persistCart() {
    localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
}

function loadCart() {
    try {
        cart = JSON.parse(localStorage.getItem(CART_STORAGE_KEY) || '[]');
        if (!Array.isArray(cart)) cart = [];
        cart = cart.map((item) => {
            const normalizedName = item.name === 'Floor Cleaner'
                ? 'Lemon Bio Enzyme Floor Cleaner'
                : item.name;
            return {
                ...item,
                name: normalizedName,
                ...getProductConfig(normalizedName, item.price, item.image),
                qty: Number(item.qty) || 1
            };
        });
    } catch {
        cart = [];
    }
}

function getCheckoutFieldIds() {
    return [
        'custName',
        'custPhone',
        'custAltPhone',
        'custMail',
        'addAddress',
        'addState',
        'addPin',
        'addLandmark'
    ];
}

function saveCheckoutDraft() {
    const draft = {};
    getCheckoutFieldIds().forEach((id) => {
        const element = document.getElementById(id);
        if (element) draft[id] = element.value;
    });
    localStorage.setItem(CHECKOUT_STORAGE_KEY, JSON.stringify(draft));
}

function loadCheckoutDraft() {
    try {
        const draft = JSON.parse(localStorage.getItem(CHECKOUT_STORAGE_KEY) || '{}');
        getCheckoutFieldIds().forEach((id) => {
            const element = document.getElementById(id);
            if (element && typeof draft[id] === 'string') {
                element.value = draft[id];
            }
        });
    } catch {
        localStorage.removeItem(CHECKOUT_STORAGE_KEY);
    }
}

function clearCheckoutDraft() {
    localStorage.removeItem(CHECKOUT_STORAGE_KEY);
}

function resetCheckoutForm() {
    getCheckoutFieldIds().forEach((id) => {
        const element = document.getElementById(id);
        if (element) element.value = '';
    });
}

function attachPointerGlow(selector) {
    document.querySelectorAll(selector).forEach((element) => {
        element.addEventListener('pointermove', (event) => {
            const rect = element.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            element.style.setProperty('--glow-x', `${x}px`);
            element.style.setProperty('--glow-y', `${y}px`);
        });

        element.addEventListener('pointerleave', () => {
            element.style.removeProperty('--glow-x');
            element.style.removeProperty('--glow-y');
        });
    });
}

function setupComparisonHover() {
    const table = document.querySelector('.premium-table');
    if (!table) return;

    const clearFocus = () => {
        table.classList.remove('focus-chemical', 'focus-beeserth');
    };

    table.querySelectorAll('th, td').forEach((cell) => {
        cell.addEventListener('mouseenter', () => {
            if (cell.cellIndex === 1) {
                table.classList.add('focus-chemical');
                table.classList.remove('focus-beeserth');
            } else if (cell.cellIndex === 2) {
                table.classList.add('focus-beeserth');
                table.classList.remove('focus-chemical');
            } else {
                clearFocus();
            }
        });
    });

    table.addEventListener('mouseleave', clearFocus);
}

function setupFixedHeaderNavigation() {
    const headerOffset = () => {
        const banner = document.querySelector('.top-banner');
        const header = document.querySelector('.main-header');
        return (banner ? banner.offsetHeight : 0) + (header ? header.offsetHeight : 0) + 18;
    };

    document.querySelectorAll('.nav-center a[href^="#"]').forEach((link) => {
        link.addEventListener('click', (event) => {
            event.preventDefault();
            const target = document.querySelector(link.getAttribute('href'));
            if (!target) return;

            const y = target.getBoundingClientRect().top + window.pageYOffset - headerOffset();
            window.scrollTo({ top: y, behavior: 'smooth' });
        });
    });
}

function setupCarousel() {
    const carousel = document.querySelector('.marquee-section');
    const viewport = carousel ? carousel.querySelector('.carousel-viewport') : null;
    const track = carousel ? carousel.querySelector('.marquee-track') : null;
    const dotsContainer = carousel ? carousel.querySelector('.carousel-dots') : null;
    const prevButton = carousel ? carousel.querySelector('.carousel-arrow.prev') : null;
    const nextButton = carousel ? carousel.querySelector('.carousel-arrow.next') : null;
    const sourceSlides = track ? Array.from(track.querySelectorAll('.carousel-slide')) : [];
    if (!carousel || !viewport || !track || !dotsContainer || !prevButton || !nextButton || sourceSlides.length === 0) return;

    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const realSlideCount = sourceSlides.length;
    const firstClone = sourceSlides[0].cloneNode(true);
    const lastClone = sourceSlides[sourceSlides.length - 1].cloneNode(true);
    firstClone.dataset.clone = 'true';
    lastClone.dataset.clone = 'true';
    track.appendChild(firstClone);
    track.insertBefore(lastClone, track.firstChild);

    const slides = Array.from(track.querySelectorAll('.carousel-slide'));
    let currentPosition = 1;
    let targetPosition = 1;
    let animationFrameId = 0;
    let resumeTimer = 0;
    let lastFrameTime = 0;
    let isPointerDown = false;
    let isAutoRunning = !motionPreference.matches;
    let isAnimatingToTarget = false;
    let dragStartX = 0;
    let dragStartPosition = 1;

    const AUTO_SLIDES_PER_SECOND = 0.115;
    const TARGET_EASE = 7.2;
    dotsContainer.innerHTML = '';

    const slideWidth = () => viewport.getBoundingClientRect().width;
    const slideRatio = () => parseFloat(getComputedStyle(carousel).getPropertyValue('--carousel-slide-ratio')) || 0.5;
    const slidePitch = () => slideWidth() * slideRatio();
    const sidePeek = () => (slideWidth() - slidePitch()) / 2;
    const baseTranslateFor = (position) => sidePeek() - (slidePitch() * position);
    const normalizeLoopPosition = (position) => {
        let nextPosition = position;
        while (nextPosition >= realSlideCount + 1) nextPosition -= realSlideCount;
        while (nextPosition < 0) nextPosition += realSlideCount;
        return nextPosition;
    };
    const getClosestSlideDistance = (slideIndex) => {
        const candidates = [
            Math.abs(slideIndex - currentPosition),
            Math.abs(slideIndex - (currentPosition - realSlideCount)),
            Math.abs(slideIndex - (currentPosition + realSlideCount))
        ];
        return Math.min(...candidates);
    };
    const getNormalizedCenterIndex = () => {
        const roundedPosition = Math.round(currentPosition);
        const centerIndex = ((roundedPosition - 1) % realSlideCount + realSlideCount) % realSlideCount;
        return centerIndex;
    };
    const applyTrackPosition = () => {
        track.style.transform = `translate3d(${baseTranslateFor(currentPosition)}px, 0, 0)`;
    };

    const dots = sourceSlides.map((_, index) => {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'carousel-dot';
        dot.setAttribute('aria-label', `Go to slide ${index + 1}`);
        dot.addEventListener('click', () => {
            stopAutoMotion();
            moveToNearest(index + 1);
            scheduleAutoResume();
        });
        dotsContainer.appendChild(dot);
        return dot;
    });

    const updateDots = () => {
        const activeDotIndex = getNormalizedCenterIndex();
        dots.forEach((dot, index) => {
            const isActive = index === activeDotIndex;
            dot.classList.toggle('active', isActive);
            dot.setAttribute('aria-current', isActive ? 'true' : 'false');
        });
    };

    const updateSlideStyles = () => {
        slides.forEach((slide, slideIndex) => {
            const image = slide.querySelector('img');
            if (!image) return;

            const distance = Math.min(getClosestSlideDistance(slideIndex), 2.25);
            const emphasis = Math.max(0, 1 - distance / 1.15);
            const sidePresence = Math.max(0, 1 - Math.abs(distance - 1) / 0.95);
            const scale = 0.82 + emphasis * 0.18 + sidePresence * 0.03;
            const opacity = 0.2 + emphasis * 0.8 + sidePresence * 0.2;
            const blur = Math.max(0, 1.15 - emphasis * 1.15 - sidePresence * 0.38);
            const saturation = 0.72 + emphasis * 0.28 + sidePresence * 0.09;
            const brightness = 0.82 + emphasis * 0.18 + sidePresence * 0.04;
            const shadowStrength = 0.08 + emphasis * 0.1 + sidePresence * 0.04;
            const shadowY = 14 + emphasis * 16 + sidePresence * 6;
            const shadowBlur = 24 + emphasis * 34 + sidePresence * 8;

            image.style.setProperty('--slide-scale', scale.toFixed(3));
            image.style.setProperty('--slide-opacity', Math.min(opacity, 1).toFixed(3));
            image.style.setProperty('--slide-blur', `${blur.toFixed(3)}px`);
            image.style.setProperty('--slide-saturation', saturation.toFixed(3));
            image.style.setProperty('--slide-brightness', brightness.toFixed(3));
            image.style.setProperty('--slide-shadow', `0 ${shadowY.toFixed(1)}px ${shadowBlur.toFixed(1)}px rgba(0, 31, 63, ${shadowStrength.toFixed(3)})`);
        });
    };

    const render = () => {
        currentPosition = normalizeLoopPosition(currentPosition);
        targetPosition = normalizeLoopPosition(targetPosition);
        applyTrackPosition();
        updateSlideStyles();
        updateDots();
    };

    const moveToNearest = (desiredIndex) => {
        const candidatePositions = [
            desiredIndex,
            desiredIndex + realSlideCount,
            desiredIndex - realSlideCount
        ];
        targetPosition = candidatePositions.reduce((closest, candidate) => (
            Math.abs(candidate - currentPosition) < Math.abs(closest - currentPosition) ? candidate : closest
        ), candidatePositions[0]);
        isAnimatingToTarget = true;
    };

    const stopAutoMotion = () => {
        isAutoRunning = false;
        window.clearTimeout(resumeTimer);
        resumeTimer = 0;
    };

    const scheduleAutoResume = () => {
        stopAutoMotion();
        if (motionPreference.matches || realSlideCount < 2) return;
        resumeTimer = window.setTimeout(() => {
            isAutoRunning = true;
        }, 1200);
    };

    const finishInteraction = () => {
        if (!isPointerDown) return;
        isPointerDown = false;
        viewport.classList.remove('is-dragging');
        moveToNearest(Math.round(currentPosition));
        scheduleAutoResume();
    };

    viewport.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        isPointerDown = true;
        dragStartX = event.clientX;
        dragStartPosition = currentPosition;
        viewport.classList.add('is-dragging');
        stopAutoMotion();
        isAnimatingToTarget = false;
        if (typeof viewport.setPointerCapture === 'function') {
            viewport.setPointerCapture(event.pointerId);
        }
    });

    viewport.addEventListener('pointermove', (event) => {
        if (!isPointerDown) return;
        const deltaX = event.clientX - dragStartX;
        currentPosition = normalizeLoopPosition(dragStartPosition - (deltaX / slidePitch()));
        render();
    });

    viewport.addEventListener('pointerup', finishInteraction);
    viewport.addEventListener('pointercancel', finishInteraction);
    viewport.addEventListener('lostpointercapture', finishInteraction);

    prevButton.addEventListener('click', () => {
        stopAutoMotion();
        moveToNearest(Math.round(currentPosition) - 1);
        scheduleAutoResume();
    });

    nextButton.addEventListener('click', () => {
        stopAutoMotion();
        moveToNearest(Math.round(currentPosition) + 1);
        scheduleAutoResume();
    });

    const animateFrame = (timestamp) => {
        if (!lastFrameTime) lastFrameTime = timestamp;
        const deltaSeconds = Math.min((timestamp - lastFrameTime) / 1000, 0.05);
        lastFrameTime = timestamp;

        if (!isPointerDown) {
            if (isAnimatingToTarget) {
                const distance = targetPosition - currentPosition;
                currentPosition += distance * Math.min(deltaSeconds * TARGET_EASE, 1);
                if (Math.abs(distance) < 0.0025) {
                    currentPosition = targetPosition;
                    isAnimatingToTarget = false;
                }
            } else if (isAutoRunning && realSlideCount > 1) {
                currentPosition += AUTO_SLIDES_PER_SECOND * deltaSeconds;
            }
        }

        render();
        animationFrameId = window.requestAnimationFrame(animateFrame);
    };

    window.addEventListener('resize', render);

    const handleMotionChange = (event) => {
        if (event.matches) {
            stopAutoMotion();
        } else if (!isPointerDown) {
            isAutoRunning = true;
        }
    };

    if (typeof motionPreference.addEventListener === 'function') {
        motionPreference.addEventListener('change', handleMotionChange);
    } else if (typeof motionPreference.addListener === 'function') {
        motionPreference.addListener(handleMotionChange);
    }

    render();
    animationFrameId = window.requestAnimationFrame(animateFrame);
}

function attachCheckoutDraftPersistence() {
    getCheckoutFieldIds().forEach((id) => {
        const element = document.getElementById(id);
        if (!element) return;
        element.addEventListener('input', saveCheckoutDraft);
        element.addEventListener('change', saveCheckoutDraft);
    });
}

function reloadHome() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setTimeout(() => window.location.reload(), 180);
}

function changeLocalQty(id, n) {
    const el = document.getElementById(id);
    const current = parseInt(el.innerText, 10);
    el.innerText = Math.max(1, current + n);
}

function toggleCart() {
    const cartDrawer = document.getElementById('cart-drawer');
    const cartBackdrop = document.getElementById('cart-backdrop');
    const shouldOpen = !cartDrawer.classList.contains('open');

    cartDrawer.classList.toggle('open', shouldOpen);
    if (cartBackdrop) cartBackdrop.classList.toggle('open', shouldOpen);
    document.body.classList.toggle('cart-is-open', shouldOpen);
}

function closeCart() {
    const cartDrawer = document.getElementById('cart-drawer');
    const cartBackdrop = document.getElementById('cart-backdrop');
    if (cartDrawer) cartDrawer.classList.remove('open');
    if (cartBackdrop) cartBackdrop.classList.remove('open');
    document.body.classList.remove('cart-is-open');
}

function addToCart(name, price, qtyId, image) {
    const quantityToAdd = parseInt(document.getElementById(qtyId).innerText, 10);
    const existing = cart.find((item) => item.name === name);
    const productConfig = getProductConfig(name, price, image);

    if (existing) {
        existing.qty += quantityToAdd;
    } else {
        cart.push({ ...productConfig, qty: quantityToAdd });
    }

    persistCart();
    document.getElementById(qtyId).innerText = '1';
    updateCartUI();
    const cartDrawer = document.getElementById('cart-drawer');
    const cartBackdrop = document.getElementById('cart-backdrop');
    if (cartDrawer) cartDrawer.classList.add('open');
    if (cartBackdrop) cartBackdrop.classList.add('open');
    document.body.classList.add('cart-is-open');
}

function changeCartQty(index, delta) {
    const item = cart[index];
    if (!item) return;

    item.qty += delta;
    if (item.qty <= 0) {
        cart.splice(index, 1);
    }

    persistCart();
    updateCartUI();
}

function removeFromCart(index) {
    cart.splice(index, 1);
    persistCart();
    updateCartUI();
}

function updateCartUI() {
    const list = document.getElementById('cart-items-list');
    const count = document.getElementById('cart-count');
    const grandTotalElement = document.getElementById('cart-grand-total');
    list.innerHTML = '';
    const pricing = calculateCartPricing();

    if (cart.length === 0) {
        list.innerHTML = '<div class="cart-empty">Add a product to see your selection here.</div>';
    }

    cart.forEach((item, index) => {
        const lineTotal = item.price * item.qty;
        const sizeLabel = item.unitLabel ? `<span>${item.unitLabel}</span>` : '';
        const priceLabel = item.originalPrice && item.originalPrice > item.price
            ? `<span class="cart-price-group"><span class="cart-price-original">${formatUnitPriceLabel(item.originalPrice)}</span><span class="cart-price-current">${formatUnitPriceLabel(item.price)}</span></span>`
            : `<span class="cart-price-current">${formatUnitPriceLabel(item.price)}</span>`;
        list.innerHTML += `
            <div class="cart-item-card">
                <div class="cart-item-thumb">
                    <img src="${escapeHTML(item.image)}" alt="${escapeHTML(item.name)}">
                </div>
                <div class="cart-item-details">
                    <div class="cart-item-name">${escapeHTML(item.name)}</div>
                    <div class="cart-item-meta">
                        ${sizeLabel}
                        <span>Qty: ${item.qty}</span>
                        <span>Price: ${priceLabel}</span>
                        <span>Total: Rs ${formatMoney(lineTotal)}</span>
                    </div>
                    <div class="cart-item-actions">
                        <div class="cart-qty-control">
                            <button onclick="changeCartQty(${index}, -1)" aria-label="Decrease quantity">-</button>
                            <span>${item.qty}</span>
                            <button onclick="changeCartQty(${index}, 1)" aria-label="Increase quantity">+</button>
                        </div>
                        <button class="cart-remove" onclick="removeFromCart(${index})">Remove</button>
                    </div>
                </div>
            </div>`;
    });

    count.innerText = pricing.totalQty;
    grandTotalElement.innerText = formatMoney(pricing.grandTotal, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function openCheckout() {
    if (cart.length === 0) return showCheckoutFeedback('Your cart is empty.');
    if (document.getElementById('cart-drawer').classList.contains('open')) closeCart();
    document.getElementById('checkout-view').style.display = 'flex';
}

function closeCheckout() {
    document.getElementById('checkout-view').style.display = 'none';
    cancelOrderConfirmation();
}

function openNotifyModal(itemName) {
    pendingNotifyItem = itemName;
    const modal = document.getElementById('notify-view');
    const title = document.getElementById('notify-product-name');
    if (title) title.textContent = itemName;
    if (modal) modal.style.display = 'flex';
    hideNotifyFeedback();
}

function closeNotifyModal() {
    const modal = document.getElementById('notify-view');
    if (modal) modal.style.display = 'none';
    pendingNotifyItem = '';
    resetNotifyForm();
}

function openProductInfoModal() {
    const modal = document.getElementById('product-info-view');
    if (modal) modal.style.display = 'flex';
}

function closeProductInfoModal() {
    const modal = document.getElementById('product-info-view');
    if (modal) modal.style.display = 'none';
}

function getCheckoutFeedbackElement() {
    return document.getElementById('checkout-feedback');
}

function getCheckoutConfirmationElement() {
    return document.getElementById('checkout-confirmation');
}

function showCheckoutFeedback(message, type = 'error') {
    const feedback = getCheckoutFeedbackElement();
    if (!feedback) return;
    feedback.textContent = message;
    feedback.classList.remove('hidden', 'success');
    if (type === 'success') feedback.classList.add('success');
}

function hideCheckoutFeedback() {
    const feedback = getCheckoutFeedbackElement();
    if (!feedback) return;
    feedback.classList.add('hidden');
    feedback.classList.remove('success');
    feedback.textContent = '';
}

function getNotifyFeedbackElement() {
    return document.getElementById('notify-feedback');
}

function showNotifyFeedback(message, type = 'error') {
    const feedback = getNotifyFeedbackElement();
    if (!feedback) return;
    feedback.textContent = message;
    feedback.classList.remove('hidden', 'success');
    if (type === 'success') feedback.classList.add('success');
}

function hideNotifyFeedback() {
    const feedback = getNotifyFeedbackElement();
    if (!feedback) return;
    feedback.classList.add('hidden');
    feedback.classList.remove('success');
    feedback.textContent = '';
}

function resetNotifyForm() {
    ['notifyName', 'notifyPhone', 'notifyEmail', 'notifyAddress', 'notifyState', 'notifyPin'].forEach((id) => {
        const element = document.getElementById(id);
        if (element) element.value = '';
    });
    const submitBtn = document.getElementById('notifySubmitBtn');
    if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerText = 'Notify Me';
    }
}

function validateNotifyData() {
    const name = document.getElementById('notifyName').value.trim();
    const phone = document.getElementById('notifyPhone').value.trim();
    const address = document.getElementById('notifyAddress').value.trim();
    const state = document.getElementById('notifyState').value.trim();
    const pin = document.getElementById('notifyPin').value.trim();

    if (!pendingNotifyItem) {
        showNotifyFeedback('Please choose a product first.');
        return false;
    }

    if (!name || !phone || !address || !state || !pin) {
        showNotifyFeedback('Please fill your name, WhatsApp number, address, state, and pincode.');
        return false;
    }

    if (!/^\d{6}$/.test(pin)) {
        showNotifyFeedback('Please enter a valid 6-digit pincode.');
        return false;
    }

    hideNotifyFeedback();
    return true;
}

async function submitNotifyRequest() {
    const submitBtn = document.getElementById('notifySubmitBtn');
    if (!validateNotifyData()) return;

    submitBtn.disabled = true;
    submitBtn.innerText = 'Saving...';
    const notifyData = buildNotifyPayload();

    try {
        await saveSheetRequest(notifyData, 'Could not save your notify request.');
    } catch (error) {
        console.error('Notify save error:', error);
        showNotifyFeedback(error.message || 'Could not save your notify request.');
        submitBtn.disabled = false;
        submitBtn.innerText = 'Notify Me';
        return;
    }

    showNotifyFeedback(`Thank you. We will notify you when ${pendingNotifyItem} is available. Redirecting to WhatsApp...`, 'success');
    submitBtn.innerText = 'Redirecting...';

    window.setTimeout(() => {
        redirectToWhatsApp(buildNotifyWhatsAppMessage(notifyData));
    }, WHATSAPP_REDIRECT_DELAY_MS);
}

function cancelOrderConfirmation() {
    pendingOrder = null;
    const confirmation = getCheckoutConfirmationElement();
    if (confirmation) confirmation.classList.add('hidden');
    const submitBtn = document.getElementById('submitBtn');
    if (submitBtn) {
        submitBtn.classList.remove('hidden');
        submitBtn.disabled = false;
        submitBtn.innerText = 'Place Order';
    }
    const confirmBtn = document.getElementById('confirmOrderBtn');
    if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.innerText = 'Confirm Order';
    }
}

function collectOrderData() {
    const pricing = calculateCartPricing();
    const orderData = {
        orderId: generateOrderId(),
        orderTimestamp: getOrderTimestamp(),
        status: 'Confirmed',
        name: document.getElementById('custName').value.trim(),
        phone: document.getElementById('custPhone').value.trim(),
        altPhone: document.getElementById('custAltPhone').value.trim(),
        mail: document.getElementById('custMail').value.trim(),
        address: document.getElementById('addAddress').value.trim(),
        state: document.getElementById('addState').value.trim(),
        pin: document.getElementById('addPin').value.trim(),
        landmark: document.getElementById('addLandmark').value.trim(),
        orderItems: cart.map((item) => `${item.name} (x${item.qty})`).join(', '),
        orderItemsLines: cart.map((item) => {
            const sizeLabel = item.unitLabel ? ` (${item.unitLabel})` : '';
            return `${item.name}${sizeLabel} x ${item.qty} - Rs ${formatMoney(item.price * item.qty)}`;
        }).join('\n'),
        quantity: pricing.totalQty,
        subtotal: formatMoney(pricing.subtotal),
        grandTotal: formatMoney(pricing.grandTotal, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
    };

    return orderData;
}

function validateOrderData(orderData) {
    const requiredFields = [
        ['custName', 'Full Name'],
        ['custPhone', 'WhatsApp Number'],
        ['addAddress', 'Address'],
        ['addState', 'State'],
        ['addPin', 'Pincode']
    ];

    const missing = requiredFields
        .filter(([id]) => !document.getElementById(id).value.trim())
        .map(([, label]) => label);

    if (missing.length > 0) {
        showCheckoutFeedback(`Please fill these required details: ${missing.join(', ')}`);
        return false;
    }

    if (!/^\d{6}$/.test(orderData.pin)) {
        showCheckoutFeedback('Please enter a valid 6-digit pincode.');
        return false;
    }

    hideCheckoutFeedback();
    return true;
}

function prepareOrder() {
    const orderData = collectOrderData();
    if (!validateOrderData(orderData)) return;

    pendingOrder = orderData;
    const confirmation = getCheckoutConfirmationElement();
    const confirmationText = document.getElementById('checkout-confirmation-text');
    const submitBtn = document.getElementById('submitBtn');

    if (confirmation && confirmationText) {
        confirmationText.textContent = 'Please confirm your order. We will save it securely first, then continue to WhatsApp.';
        confirmation.classList.remove('hidden');
    }

    if (submitBtn) submitBtn.classList.add('hidden');
}

async function finalizeOrder() {
    const confirmBtn = document.getElementById('confirmOrderBtn');
    const submitBtn = document.getElementById('submitBtn');
    const orderData = pendingOrder || collectOrderData();

    if (!validateOrderData(orderData)) return;
    if (!ORDER_API_URL) {
        showCheckoutFeedback('Order sheet endpoint is not configured yet.');
        return;
    }

    confirmBtn.disabled = true;
    confirmBtn.innerText = 'Saving Order...';

    try {
        await saveSheetRequest(buildSheetPayload(orderData), 'Could not save the order to the online sheet.');
    } catch (error) {
        console.error('Remote sheet save error:', error);
        showCheckoutFeedback(error.message || 'Could not save the order to the online sheet.');
        confirmBtn.disabled = false;
        confirmBtn.innerText = 'Confirm Order';
        return;
    }

    confirmBtn.innerText = 'Redirecting...';
    showCheckoutFeedback(`Thank you, ${orderData.name}. Your order is confirmed and saved. Your Order ID is ${orderData.orderId}. Redirecting to WhatsApp...`, 'success');

    window.setTimeout(() => {
        cart = [];
        pendingOrder = null;
        persistCart();
        clearCheckoutDraft();
        resetCheckoutForm();
        updateCartUI();

        const confirmation = getCheckoutConfirmationElement();
        if (confirmation) confirmation.classList.add('hidden');
        if (submitBtn) {
            submitBtn.classList.remove('hidden');
            submitBtn.disabled = false;
            submitBtn.innerText = 'Place Order';
        }
        confirmBtn.disabled = false;
        confirmBtn.innerText = 'Confirm Order';

        redirectToWhatsApp(buildWhatsAppMessage(orderData));
    }, WHATSAPP_REDIRECT_DELAY_MS);
}

function initInteractiveEffects() {
    loadCart();
    attachPointerGlow('.btn-royal, .item-qty-selector button, .cart-trigger, .insta-link, .product-card');
    setupCarousel();
    setupComparisonHover();
    setupFixedHeaderNavigation();
    attachCheckoutDraftPersistence();
    loadCheckoutDraft();
    updateCartUI();
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        closeCart();
        closeCheckout();
        closeNotifyModal();
        closeProductInfoModal();
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initInteractiveEffects);
} else {
    initInteractiveEffects();
}
