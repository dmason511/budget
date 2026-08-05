(() => {
  async function applyAdminOnlyVisibility() {
    const adminOnlyItems = document.querySelectorAll("[data-admin-only]");
    if (!adminOnlyItems.length) {
      return;
    }

    let isAdmin = false;

    try {
      const response = await fetch("/api/auth/me");
      if (response.ok) {
        const payload = await response.json();
        isAdmin = payload?.data?.role === "admin";
      }
    } catch (error) {
      console.error("Failed to load auth profile", error);
    }

    adminOnlyItems.forEach((item) => {
      item.hidden = !isAdmin;
    });
  }

  function setupLogoutButtons() {
    const logoutButtons = document.querySelectorAll("[data-auth-logout]");
    if (!logoutButtons.length) {
      return;
    }

    logoutButtons.forEach((button) => {
      button.addEventListener("click", async () => {
        if (button.disabled) {
          return;
        }

        button.disabled = true;
        const originalText = button.textContent;
        button.textContent = "Signing Out...";

        try {
          await fetch("/api/auth/logout", {
            method: "POST",
          });
        } catch (error) {
          console.error("Logout request failed", error);
        } finally {
          button.textContent = originalText;
          window.location.assign("/login");
        }
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      setupLogoutButtons();
      applyAdminOnlyVisibility();
    });
  } else {
    setupLogoutButtons();
    applyAdminOnlyVisibility();
  }
})();
