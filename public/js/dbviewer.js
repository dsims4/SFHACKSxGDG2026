document.querySelectorAll(".toggle-more").forEach((button) => {
    const cell = document.getElementById(button.getAttribute("data-for"));
    if (!cell || cell.textContent.length < 220) {
        button.hidden = true;
        return;
    }

    button.addEventListener("click", () => {
        const open = cell.classList.toggle("open");
        button.textContent = open ? "less" : "more";
    });
});
