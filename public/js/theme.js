(() => {
    const key = "newstralizer-theme";
    let theme = "light";
    try {
        if (sessionStorage.getItem(key) === "dark") theme = "dark";
    } catch {
        // Theme switching still works when browser storage is unavailable.
    }
    document.documentElement.dataset.theme = theme;

    document.addEventListener("DOMContentLoaded", () => {
        const button = document.getElementById("theme-toggle");
        if (!button) return;
        function updateButton() {
            const dark = document.documentElement.dataset.theme === "dark";
            button.textContent = dark ? "Light theme" : "Dark theme";
            button.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
        }
        updateButton();
        button.addEventListener("click", () => {
            theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
            document.documentElement.dataset.theme = theme;
            try { sessionStorage.setItem(key, theme); } catch { /* Keep the in-page preference. */ }
            updateButton();
        });
    });
})();
