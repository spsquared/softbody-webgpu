let canLoad = true;
const loadingCover = document.getElementById('loadingCover');
const loadingError = document.getElementById('loadingError');
const errorListener = (err) => {
    loadingError.innerText += `\n${err.message} (at ${err.filename} ${err.lineno}:${err.colno})`;
    loadingCover.style.opacity = 1;
    canLoad = false;
};
document.addEventListener('DOMContentLoaded', async () => {
    loadingCover.style.opacity = 0;
    loadingCover.style.pointerEvents = 'none';
    await Promise.all([
        new Promise((resolve) => window.addEventListener('load', resolve)),
        new Promise((resolve) => setTimeout(resolve, 200))
    ]);
    if (!canLoad) {
        loadingCover.style.opacity = 1;
        loadingCover.style.pointerEvents = '';
        return;
    }
    loadingCover.remove();
    window.removeEventListener('error', errorListener);
    if (document.getElementById('main').children.length == 0) window.location.reload();
});
window.addEventListener('error', errorListener);