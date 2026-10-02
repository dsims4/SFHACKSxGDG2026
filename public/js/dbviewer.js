document.querySelectorAll(".toggle-more").forEach((button) => {
    const cell = document.getElementById(button.getAttribute("data-for"));
    if (!cell || cell.scrollHeight <= cell.clientHeight + 1) {
        button.hidden = true;
        return;
    }

    button.hidden = false;
    button.addEventListener("click", () => {
        const open = cell.classList.toggle("open");
        button.textContent = open ? "less" : "more";
    });
});
