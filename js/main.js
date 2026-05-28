/* ============================================================
   我们的小世界 — main.js （HTTP 服务版）
   ============================================================ */

// ── State ────────────────────────────────────────────────────
const state = {
    anniversary: null,  // ISO date string "YYYY-MM-DD"
    siteName:    null,  // custom display name
};

// ── Boot ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    loadState().then(() => {
        initSetupModal();
        initNav();
        initScrollAnimations();
        updateDisplay();
        initPhotoSlideshow();
    });

    const yearEl = document.getElementById('currentYear');
    if (yearEl) yearEl.textContent = new Date().getFullYear();
});

// ── Persistence（通过 HTTP API） ─────────────────────────────
async function loadState() {
    try {
        const settings = await API.getSettings();
        if (settings.anniversary) state.anniversary = settings.anniversary;
        if (settings.siteName)    state.siteName    = settings.siteName;
    } catch (e) {
        console.warn('⚠️ 无法连接服务器，请确认服务已启动');
    }
}

async function saveAnniversary(val) {
    await API.saveSetting('anniversary', val);
    state.anniversary = val;
}

async function saveSiteName(val) {
    await API.saveSetting('siteName', val || '');
    state.siteName = val;
}

// ── Setup Modal ───────────────────────────────────────────────
function initSetupModal() {
    const overlay   = document.getElementById('setupModal');
    const submitBtn = document.getElementById('setupSubmit');
    const dateInput = document.getElementById('anniversaryDate');
    const nameInput = document.getElementById('siteName');

    if (!overlay) return;

    if (state.anniversary) {
        overlay.classList.add('hidden');
        return;
    }

    dateInput.value = new Date().toISOString().slice(0, 10);

    submitBtn.addEventListener('click', async () => {
        if (!dateInput.value) {
            dateInput.focus();
            dateInput.style.borderColor = '#D4878F';
            return;
        }
        await saveAnniversary(dateInput.value);
        const name = nameInput.value.trim() || null;
        if (name) await saveSiteName(name);
        state.siteName = name;

        overlay.classList.add('hidden');
        updateDisplay();
    });
}

// ── Display ───────────────────────────────────────────────────
function updateDisplay() {
    // Days & months counters
    if (state.anniversary) {
        const days   = getDaysTogether();
        const months = getMonthsTogether();
        animateCounter('daysCount',   days);
        animateCounter('monthsCount', months);
    }

    // Brand name override
    if (state.siteName) {
        const el = document.getElementById('brandText');
        if (el) el.textContent = state.siteName;
        document.title = state.siteName + ' | 我们的小世界';
    }

    // Today's date card
    const todayEl = document.getElementById('todayDate');
    if (todayEl) todayEl.textContent = formatDateCN(new Date());
}

// ── Date Utilities ────────────────────────────────────────────
function getDaysTogether() {
    const start = new Date(state.anniversary);
    const now   = new Date();
    return Math.max(0, Math.floor((now - start) / 86_400_000));
}

function getMonthsTogether() {
    const start = new Date(state.anniversary);
    const now   = new Date();
    return Math.max(
        0,
        (now.getFullYear() - start.getFullYear()) * 12 +
        (now.getMonth() - start.getMonth())
    );
}

function formatDateCN(date) {
    return date.toLocaleDateString('zh-CN', {
        year:  'numeric',
        month: 'long',
        day:   'numeric',
    });
}

// ── Counter Animation ─────────────────────────────────────────
function animateCounter(id, target) {
    const el = document.getElementById(id);
    if (!el || target === 0) return;

    let current  = 0;
    const frames = 60;
    const step   = target / frames;

    const tick = () => {
        current = Math.min(current + step, target);
        el.textContent = Math.floor(current).toLocaleString('zh-CN');
        if (current < target) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}

// ── Navigation ────────────────────────────────────────────────
function initNav() {
    const nav    = document.getElementById('mainNav');
    const toggle = document.getElementById('navToggle');
    const links  = document.getElementById('navLinks');

    if (!nav) return;

    // Sticky style on scroll
    const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    // Mobile hamburger
    toggle?.addEventListener('click', () => {
        links.classList.toggle('open');
        toggle.classList.toggle('active');
    });

    // Close mobile menu when any link is tapped
    links?.querySelectorAll('a').forEach(a =>
        a.addEventListener('click', () => {
            links.classList.remove('open');
            toggle?.classList.remove('active');
        })
    );
}

// ── Homepage Photo Slideshow ──────────────────────────────────
async function initPhotoSlideshow() {
    const card = document.querySelector('.vis-card-front');
    if (!card) return;
    try {
        const [modeRes, photosRes] = await Promise.all([
            fetch('/api/mode').then(r => r.json()).catch(() => ({ mode: 'local' })),
            fetch('/api/photos/random?count=8').then(r => r.json()).catch(() => []),
        ]);
        if (!photosRes.length) return;
        const isCloud = modeRes.mode === 'cloud';
        let idx = 0;

        async function getPhotoSrc(p) {
            if (!isCloud) return `/uploads/${p.filename}`;
            const res = await fetch(`/api/photos/${p.id}/data`).then(r => r.json()).catch(() => ({}));
            return res.data ? `data:image/jpeg;base64,${res.data}` : null;
        }

        async function showSlide(i) {
            const p = photosRes[i];
            const src = await getPhotoSrc(p);
            if (!src) return;
            card.innerHTML = `
                <div class="slideshow-wrap">
                    <img src="${src}" alt="${(p.description || p.original_name || '').replace(/"/g,'&quot;')}" class="slideshow-img">
                    ${p.description ? `<div class="slideshow-caption">${p.description}</div>` : ''}
                </div>`;
        }

        await showSlide(0);

        if (photosRes.length > 1) {
            setInterval(() => {
                idx = (idx + 1) % photosRes.length;
                showSlide(idx);
            }, 5000);
        }
    } catch (_) {}
}

// ── Scroll-triggered Fade-up Animations ───────────────────────
function initScrollAnimations() {
    const targets = document.querySelectorAll('.feat-card, .section-head');
    targets.forEach(el => el.classList.add('fade-up'));

    const observer = new IntersectionObserver(
        entries => entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                observer.unobserve(entry.target);
            }
        }),
        { threshold: 0.1 }
    );

    targets.forEach(el => observer.observe(el));
}
