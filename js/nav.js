/* Shared nav behavior for inner pages （HTTP 服务版） */
document.addEventListener('DOMContentLoaded', async () => {
    const nav    = document.getElementById('mainNav');
    const toggle = document.getElementById('navToggle');
    const links  = document.getElementById('navLinks');

    const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true });

    // 从服务器获取自定义站点名称
    try {
        const settings = await API.getSettings();
        if (settings.siteName) {
            const el = document.querySelector('.brand-text');
            if (el) el.textContent = settings.siteName;
        }
    } catch (_) {}

    toggle?.addEventListener('click', () => {
        links.classList.toggle('open');
        toggle.classList.toggle('active');
    });
});
