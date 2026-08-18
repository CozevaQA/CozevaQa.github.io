document.addEventListener('DOMContentLoaded', () => {
    const menuToggle = document.getElementById('menu-toggle');
    const sidebar = document.getElementById('sidebar');
    const themeToggles = document.querySelectorAll('.theme-toggle'); // Selects both mobile and desktop buttons

    // --- Mobile Sidebar Logic ---
    menuToggle.addEventListener('click', () => {
        sidebar.classList.toggle('open');
    });

    document.addEventListener('click', (event) => {
        const isClickInsideSidebar = sidebar.contains(event.target);
        const isClickOnToggle = menuToggle.contains(event.target);
        
        if (!isClickInsideSidebar && !isClickOnToggle && window.innerWidth <= 768) {
            sidebar.classList.remove('open');
        }
    });

    // --- Dark Mode Logic ---
    // Check local storage for theme preference
    const currentTheme = localStorage.getItem('theme');
    if (currentTheme === 'dark') {
        document.body.classList.add('dark-theme');
        updateIcons(true);
    }

    // Toggle theme on button click
    themeToggles.forEach(toggle => {
        toggle.addEventListener('click', () => {
            document.body.classList.toggle('dark-theme');
            let isDark = document.body.classList.contains('dark-theme');
            
            // Save preference to local storage
            localStorage.setItem('theme', isDark ? 'dark' : 'light');
            
            // Update icons
            updateIcons(isDark);
        });
    });

    // Function to swap moon/sun icons
    function updateIcons(isDark) {
        themeToggles.forEach(toggle => {
            const icon = toggle.querySelector('i');
            if (isDark) {
                icon.classList.remove('fa-moon');
                icon.classList.add('fa-sun');
            } else {
                icon.classList.remove('fa-sun');
                icon.classList.add('fa-moon');
            }
        });
    }
});