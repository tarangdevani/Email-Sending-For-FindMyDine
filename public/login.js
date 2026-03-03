(function () {
  "use strict";

  const form = document.getElementById("loginForm");
  const emailInput = document.getElementById("loginEmail");
  const passwordInput = document.getElementById("loginPassword");
  const loginBtn = document.getElementById("loginBtn");
  const loginError = document.getElementById("loginError");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginError.style.display = "none";

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
      showError("Please fill in all fields");
      return;
    }

    // UI: loading
    loginBtn.querySelector(".login-btn-text").textContent = "Signing in...";
    loginBtn.querySelector(".login-btn-spinner").style.display = "inline-block";
    loginBtn.disabled = true;

    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();

      if (data.success) {
        window.location.href = "/";
      } else {
        showError(data.message || "Invalid credentials");
      }
    } catch (err) {
      showError("Network error — please try again");
    } finally {
      loginBtn.querySelector(".login-btn-text").textContent = "Sign In";
      loginBtn.querySelector(".login-btn-spinner").style.display = "none";
      loginBtn.disabled = false;
    }
  });

  function showError(msg) {
    loginError.textContent = msg;
    loginError.style.display = "block";
    loginError.classList.add("shake");
    setTimeout(() => loginError.classList.remove("shake"), 500);
  }
})();
