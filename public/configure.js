const DEFAULT_AI_TEMPERATURE = 0.2;
const DEFAULT_NUM_RESULTS = 20;
const DEFAULT_ENABLE_HOMEPAGE = true;
const DEFAULT_ENABLE_SIMILAR = true;
const DEFAULT_INCLUDE_ADULT = false;

      const addonName = "AI Search";
      const TRAKT_CLIENT_ID = "YOUR_ADDON_CLIENT_ID"; // This will be replaced with the actual client ID from the server
      const HOST = "stremio.itcon.au"; // This will be replaced with the actual host from the server

      function setLoading(isLoading) {
        const configureBtn = document.getElementById("configureBtn");
        const copyBtn = document.getElementById("copyBtn");

        if (isLoading) {
          configureBtn.disabled = true;
          copyBtn.disabled = true;
          configureBtn.textContent = "Validating...";
          copyBtn.textContent = "Validating...";
        } else {
          configureBtn.disabled = false;
          copyBtn.disabled = false;
          configureBtn.textContent = document.getElementById("existingConfigId")
            .value
            ? "Update Configuration in Stremio"
            : "Configure Addon in Stremio";
          copyBtn.textContent = document.getElementById("existingConfigId")
            .value
            ? "Copy Updated URL"
            : "Copy Installation URL";
        }
      }

      // Add error handling functions
      function showError(message) {
        const errorDiv = document.getElementById("error");
        errorDiv.style.display = "block";
        errorDiv.textContent = message;
        document.getElementById("manual-url").style.display = "none";
      }

      function clearError() {
        const errorDiv = document.getElementById("error");
        errorDiv.style.display = "none";
        errorDiv.textContent = "";
      }

      // Update title and heading when page loads
      document.title = `${addonName} Addon Configuration`;
      window.addEventListener("DOMContentLoaded", () => {
        document.querySelector("h1").textContent = `Stremio ${addonName}`;
      });

      // Remove the old key masking functions and setup
      function setupKeyHandling() {
        const keyInputs = [
          "geminiKey",
          "openaiCompatApiKey",
          "openaiCompatModel",
          "openaiCompatBaseUrl",
          "openaiCompatExtraHeaders",
          "tmdbKey",
          "rpdbKey",
          "fanartKey",
        ];

        keyInputs.forEach((inputId) => {
          const input = document.getElementById(inputId);
          if (input) {
            // Add input event listener to trim whitespace
            input.addEventListener("input", function () {
              this.value = this.value.trim();
            });
          }
        });
      }

      // Initialize after DOM loads
      document.addEventListener("DOMContentLoaded", function () {
        // Setup key handling
        setupKeyHandling();
      });

      window.getAddonUrl = async function () {
        const values = getFormValues();
        
        // Basic validation
        if (values.aiProvider === "gemini") {
          if (!values.geminiKey || values.geminiKey.length < 10) {
            showError("Please enter a valid Gemini API key");
            return null;
          }
        } else {
          if (!values.openaiCompatApiKey || values.openaiCompatApiKey.length < 10) {
            showError("Please enter a valid OpenAI-compatible API key");
            return null;
          }
          if (!values.openaiCompatModel) {
            showError("Please enter a model name");
            return null;
          }
        }
        if (!values.tmdbKey || values.tmdbKey.length < 10) {
          showError("Please enter a valid TMDB API key");
          return null;
        }

        try {
          setLoading(true);
          const isValid = await validateApiKeys({
            aiProvider: values.aiProvider,
            geminiKey: values.geminiKey,
            openaiCompatApiKey: values.openaiCompatApiKey,
            openaiCompatModel: values.openaiCompatModel,
            openaiCompatBaseUrl: values.openaiCompatBaseUrl,
            openaiCompatExtraHeaders: values.openaiCompatExtraHeaders,
            aiTemperature: values.aiTemperature,
            tmdbKey: values.tmdbKey,
          });
          if (!isValid) return null;
          clearError();

          const payload = buildConfigPayload(values);

          // 3. Send the payload to the server
          const response = await fetch(`/aisearch/encrypt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

          if (!response.ok) throw new Error(`Failed to encrypt configuration: ${response.status}`);
          const data = await response.json();
          if (!data.encryptedConfig) throw new Error("No encrypted configuration received");

          const configId = data.encryptedConfig;
          return {
            stremio: `stremio://${window.location.host}/aisearch/${configId}/manifest.json`,
            https: `https://${window.location.host}/aisearch/${configId}/manifest.json`,
          };
        } catch (error) {
          showError("Error: " + error.message);
          return null;
        } finally {
          setLoading(false);
        }
      };

      async function validateApiKeys({
        aiProvider,
        geminiKey,
        openaiCompatApiKey,
        openaiCompatModel,
        openaiCompatBaseUrl,
        openaiCompatExtraHeaders,
        aiTemperature,
        tmdbKey,
      }) {
        const errorDiv = document.getElementById("error");
        const traktAccessToken = document
          .getElementById("traktAccessToken")
          .value.trim();
        const traktRefreshToken = document
          .getElementById("traktRefreshToken")
          .value.trim();
        const fanartKey = document.getElementById("fanartKey").value.trim();

        try {
          const response = await fetch(`/aisearch/validate`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              AiProvider: aiProvider,
              GeminiApiKey: geminiKey,
              OpenAICompatApiKey: openaiCompatApiKey,
              OpenAICompatModel: openaiCompatModel,
              OpenAICompatBaseUrl: openaiCompatBaseUrl,
              OpenAICompatExtraHeaders: openaiCompatExtraHeaders,
              AiTemperature: typeof aiTemperature === "number" ? aiTemperature : DEFAULT_AI_TEMPERATURE,
              TmdbApiKey: tmdbKey,
              FanartApiKey: fanartKey,
              TraktAccessToken: traktAccessToken,
              TraktRefreshToken: traktRefreshToken,
            }),
          });

          const result = await response.json();

          const aiOk = !!(result.ai || result.gemini || result.openaiCompat);
          if (!aiOk || !result.tmdb) {
            errorDiv.style.display = "block";
            errorDiv.textContent = Object.values(result.errors || {}).join(". ");
            return false;
          }

          // Show optional API key validation warnings (but don't block submission)
          const warnings = [];
          
          if (fanartKey && !result.fanart) {
            warnings.push("Fanart.tv: " + result.errors.fanart);
          }

          // Show Trakt validation errors if any, but don't block submission
          if (traktAccessToken && !result.trakt) {
            warnings.push("Trakt.tv: " + result.errors.trakt);
          }

          if (warnings.length > 0) {
            errorDiv.style.display = "block";
            errorDiv.textContent = "Warning: " + warnings.join("; ") + ". You can still continue, but these features may not work properly.";
          }

          return true;
        } catch (error) {
          errorDiv.style.display = "block";
          errorDiv.textContent =
            "Failed to validate API keys: " + error.message;
          return false;
        }
      }

      async function generateUrl(event) {
        if (event) {
          event.preventDefault();
        }
        const urls = await getAddonUrl();
        if (urls) {
          window.location.href = urls.stremio;
        }
      }

      async function copyUrl(event) {
        if (event) {
          event.preventDefault();
        }
        const urls = await getAddonUrl();
        if (!urls) return;

        const manualUrlDiv = document.getElementById("manual-url");
        const feedbackDiv = document.getElementById("copy-feedback");

        try {
          await navigator.clipboard.writeText(urls.https);

          // Show feedback
          feedbackDiv.style.display = "block";
          setTimeout(() => {
            feedbackDiv.style.display = "none";
          }, 2000);

          // Show manual URL
          manualUrlDiv.style.display = "block";
          manualUrlDiv.textContent = `Manual installation URL (if needed):\n${urls.https}`;
        } catch (err) {
          // Fallback for clipboard API failure
          manualUrlDiv.style.display = "block";
          manualUrlDiv.textContent = `Copy this URL manually:\n${urls.https}`;
        }
      }
      // Show/hide RPDB poster type dropdown based on API key presence
      // REMOVED this listener as visibility is now controlled by the checkbox
      /*
      document.getElementById("rpdbKey").addEventListener("input", function () {
        // ... old logic ...
      });
      */

      // Update input change handlers to not automatically clear errors
      document.getElementById("aiProvider").addEventListener("change", () => {
        document.getElementById("manual-url").style.display = "none";
      });
      document.getElementById("geminiKey").addEventListener("input", () => {
        document.getElementById("manual-url").style.display = "none";
      });
      document.getElementById("openaiCompatApiKey").addEventListener("input", () => {
        document.getElementById("manual-url").style.display = "none";
      });
      document.getElementById("openaiCompatModel").addEventListener("input", () => {
        document.getElementById("manual-url").style.display = "none";
      });
      document.getElementById("openaiCompatBaseUrl").addEventListener("input", () => {
        document.getElementById("manual-url").style.display = "none";
      });
      document.getElementById("openaiCompatExtraHeaders").addEventListener("input", () => {
        document.getElementById("manual-url").style.display = "none";
      });
      document.getElementById("tmdbKey").addEventListener("input", () => {
        document.getElementById("manual-url").style.display = "none";
      });
      document.getElementById("rpdbKey").addEventListener("input", () => {
        document.getElementById("manual-url").style.display = "none";
      });
      document.getElementById("numResults").addEventListener("input", () => {
        document.getElementById("manual-url").style.display = "none";
      });
      document.getElementById("aiTemperature").addEventListener("input", () => {
        document.getElementById("manual-url").style.display = "none";
      });
      // NEW: Add listener for the RPDB enable checkbox
      document
        .getElementById("enableRpdbPosters")
        .addEventListener("change", () => {
          document.getElementById("manual-url").style.display = "none";
        });
      // RESTORED: Add listener for enableAiCache
      document
        .getElementById("enableAiCache")
        .addEventListener("change", () => {
          document.getElementById("manual-url").style.display = "none";
        });
      // RESTORED: Add listener for rpdbPosterType
      document
        .getElementById("rpdbPosterType")
        .addEventListener("change", () => {
          document.getElementById("manual-url").style.display = "none";
        });
      // RESTORED: Add listener for traktAccessToken
      const traktAccessToken = document.getElementById("traktAccessToken");
      if (traktAccessToken) {
        traktAccessToken.addEventListener("input", () => {
          document.getElementById("manual-url").style.display = "none";
        });
      }

      function toggleHomepageQueryVisibility() {
        const enableHomepage = document.getElementById('enableHomepage').checked;
        const homepageQueryGroup = document.getElementById('homepageQueryGroup');
        homepageQueryGroup.style.display = enableHomepage ? 'block' : 'none';
      }

      function toggleAiProviderVisibility() {
        const provider = document.getElementById("aiProvider").value;
        const geminiFields = document.getElementById("geminiFields");
        const openaiCompatFields = document.getElementById("openaiCompatFields");
        const geminiModelGroup = document.getElementById("geminiModelGroup");

        if (geminiFields) geminiFields.style.display = provider === "gemini" ? "block" : "none";
        if (openaiCompatFields) openaiCompatFields.style.display = provider === "openai-compat" ? "block" : "none";
        if (geminiModelGroup) geminiModelGroup.style.display = provider === "gemini" ? "block" : "none";
      }

      function applyConfigToForm(config) {
        if (!config) return;

        if (config.AiProvider) {
          document.getElementById("aiProvider").value = config.AiProvider;
        } else if (config.OpenAICompatApiKey && !config.GeminiApiKey) {
          // Backwards-compatible detection for configs created before AiProvider existed
          document.getElementById("aiProvider").value = "openai-compat";
        }
        toggleAiProviderVisibility();

        if (config.GeminiApiKey)
          document.getElementById("geminiKey").value = config.GeminiApiKey;
        if (config.OpenAICompatApiKey)
          document.getElementById("openaiCompatApiKey").value = config.OpenAICompatApiKey;
        if (config.OpenAICompatModel)
          document.getElementById("openaiCompatModel").value = config.OpenAICompatModel;
        if (config.OpenAICompatBaseUrl)
          document.getElementById("openaiCompatBaseUrl").value = config.OpenAICompatBaseUrl;
        if (config.OpenAICompatExtraHeaders)
          document.getElementById("openaiCompatExtraHeaders").value =
            config.OpenAICompatExtraHeaders;
        if (config.TmdbApiKey) document.getElementById("tmdbKey").value = config.TmdbApiKey;
        if (config.RpdbApiKey) document.getElementById("rpdbKey").value = config.RpdbApiKey;
        if (config.FanartApiKey) document.getElementById("fanartKey").value = config.FanartApiKey;
        if (config.RpdbPosterType)
          document.getElementById("rpdbPosterType").value = config.RpdbPosterType;
        if (config.TmdbLanguage)
          document.getElementById("tmdbLanguage").value = config.TmdbLanguage;
        if (config.NumResults)
          document.getElementById("numResults").value = config.NumResults;
        if (config.AiTemperature !== undefined)
          document.getElementById("aiTemperature").value = config.AiTemperature;
        if (config.EnableAiCache !== undefined)
          document.getElementById("enableAiCache").checked = config.EnableAiCache;
        if (config.GeminiModel)
          document.getElementById("geminiModel").value = config.GeminiModel;
        if (config.EnableRpdb !== undefined) {
          document.getElementById("enableRpdbPosters").checked = config.EnableRpdb;
        } else {
          // Default to checked if RpdbApiKey exists but EnableRpdb flag is missing (older configs)
          document.getElementById("enableRpdbPosters").checked = !!config.RpdbApiKey;
        }
        if (config.EnableHomepage !== undefined) {
          document.getElementById("enableHomepage").checked = config.EnableHomepage;
        } else {
          // For older configs that don't have this setting, default it to true
          document.getElementById("enableHomepage").checked = DEFAULT_ENABLE_HOMEPAGE;
        }

        if (config.EnableSimilar !== undefined) {
          document.getElementById("enableSimilar").checked = config.EnableSimilar;
        } else {
          document.getElementById("enableSimilar").checked = DEFAULT_ENABLE_SIMILAR;
        }

        if (config.IncludeAdult !== undefined)
          document.getElementById("includeAdult").checked = config.IncludeAdult;

        if (config.HomepageQuery) {
          document.getElementById("homepageQuery").value = config.HomepageQuery;
        }

        // Call toggleRpdbFields *after* setting the checkbox state and API key
        setTimeout(toggleRpdbFields, 100);

        // RESTORED: Load Trakt configuration if available and validate token
        if (config.traktUsername) {
          // NEW CONFIG: User is already migrated.
          console.log("Loading new config with traktUsername:", config.traktUsername);
          document.getElementById("traktUsername").value = config.traktUsername;
          // The validateAndRefreshTraktToken call later will handle the UI update.
        } else if (config.TraktAccessToken) {
          // OLD CONFIG: User needs to migrate.
          console.log("Detected old configuration with an access token.");
          // We don't save the old token, as we want them to re-auth.
          // Instead, we update the UI to inform them of the required action.
          updateTraktStatus(
            "Re-Login with Trakt.tv to Update",
            "#e67e22", // An orange/warning color
            "<strong>Action Required:</strong> We've updated our Trakt integration for better reliability. Please click the button above to log in again and update your configuration."
          );
        }

        // Show advanced options if any are set (including the new checkbox)
        if (
          config.RpdbApiKey ||
          config.NumResults ||
          config.AiTemperature !== undefined ||
          config.EnableAiCache !== undefined ||
          config.TraktAccessToken ||
          config.GeminiModel ||
          config.EnableRpdb
        ) {
          document.getElementById("showAdvancedOptions").checked = true;
          document.getElementById("advancedOptions").style.display = "block";
        }

        toggleHomepageQueryVisibility();
        toggleAiProviderVisibility();

        // Update the buttons to indicate we're editing
        document.getElementById("configureBtn").textContent =
          "Update Configuration in Stremio";
        document.getElementById("copyBtn").textContent = "Copy Updated URL";
        validateAndRefreshTraktToken();
      }

      function getFormValues() {
        const aiProvider = document.getElementById("aiProvider").value;
        const geminiKey = document.getElementById("geminiKey").value.trim();
        const openaiCompatApiKey = document.getElementById("openaiCompatApiKey").value.trim();
        const openaiCompatModel = document.getElementById("openaiCompatModel").value.trim();
        const openaiCompatBaseUrl = document.getElementById("openaiCompatBaseUrl").value.trim();
        const openaiCompatExtraHeaders = document.getElementById("openaiCompatExtraHeaders").value.trim();
        const tmdbKey = document.getElementById("tmdbKey").value.trim();
        const aiTemperatureRaw = document.getElementById("aiTemperature").value.trim();
        const aiTemperatureParsed = parseFloat(aiTemperatureRaw);
        const aiTemperature = Number.isFinite(aiTemperatureParsed)
          ? Math.max(0, Math.min(1, aiTemperatureParsed))
          : DEFAULT_AI_TEMPERATURE;

        return {
          aiProvider,
          geminiKey,
          openaiCompatApiKey,
          openaiCompatModel,
          openaiCompatBaseUrl,
          openaiCompatExtraHeaders,
          tmdbKey,
          aiTemperature,
        };
      }

      function buildConfigPayload(values) {
        const configData = {
          AiProvider: values.aiProvider,
          TmdbApiKey: values.tmdbKey,
          RpdbApiKey: document.getElementById("rpdbKey").value.trim(),
          FanartApiKey: document.getElementById("fanartKey").value.trim(),
          NumResults: parseInt(document.getElementById("numResults").value.trim()) || DEFAULT_NUM_RESULTS,
          AiTemperature: values.aiTemperature,
          EnableAiCache: document.getElementById("enableAiCache").checked,
          TmdbLanguage: document.getElementById("tmdbLanguage").value,
          EnableRpdb: document.getElementById("enableRpdbPosters").checked,
          EnableHomepage: document.getElementById("enableHomepage").checked,
          IncludeAdult: document.getElementById("includeAdult").checked,
          EnableSimilar: document.getElementById("enableSimilar").checked,
        };

        if (values.aiProvider === "gemini") {
          configData.GeminiApiKey = values.geminiKey;
          configData.GeminiModel = document.getElementById("geminiModel").value;
        } else {
          configData.OpenAICompatApiKey = values.openaiCompatApiKey;
          configData.OpenAICompatModel = values.openaiCompatModel;
          if (values.openaiCompatBaseUrl) configData.OpenAICompatBaseUrl = values.openaiCompatBaseUrl;
          if (values.openaiCompatExtraHeaders)
            configData.OpenAICompatExtraHeaders = values.openaiCompatExtraHeaders;
        }

        if (configData.EnableHomepage && document.getElementById("homepageQuery").value.trim()) {
          configData.HomepageQuery = document.getElementById("homepageQuery").value.trim();
        }
        if (configData.EnableRpdb) {
          configData.RpdbPosterType = document.getElementById("rpdbPosterType").value;
        }

        const existingUsername = document.getElementById("traktUsername").value.trim();
        if (existingUsername) {
          configData.traktUsername = existingUsername;
        }

        let traktAuthData = null;
        const newAccessToken = document.getElementById("traktAccessToken").value.trim();
        if (newAccessToken && configData.traktUsername) {
          traktAuthData = {
            username: configData.traktUsername,
            accessToken: newAccessToken,
            refreshToken: document.getElementById("traktRefreshToken").value.trim(),
            expiresIn: parseInt(document.getElementById("traktExpiresIn").value.trim()) || 3600,
          };
        }

        return { configData, traktAuthData };
      }

      // Initialize the advanced section to be hidden on page load
      document.addEventListener("DOMContentLoaded", function () {
        document.getElementById("advancedOptions").style.display = "none";

        // Show/hide advanced options when checkbox is clicked
        document
          .getElementById("showAdvancedOptions")
          .addEventListener("change", function () {
            const advancedSection = document.getElementById("advancedOptions");
            advancedSection.style.display = this.checked ? "block" : "none";
          });

        // Show/hide homepage query input based on checkbox state
        toggleHomepageQueryVisibility(); // Set initial state on load
        document.getElementById('enableHomepage').addEventListener('change', toggleHomepageQueryVisibility);

        // Show/hide provider-specific fields
        toggleAiProviderVisibility();
        document.getElementById("aiProvider").addEventListener("change", toggleAiProviderVisibility);

        const configJson = document.getElementById("configJson");
        const exportConfigBtn = document.getElementById("exportConfigBtn");
        const importConfigBtn = document.getElementById("importConfigBtn");
        const copyConfigBtn = document.getElementById("copyConfigBtn");
        const clearConfigBtn = document.getElementById("clearConfigBtn");

        if (exportConfigBtn && configJson) {
          exportConfigBtn.addEventListener("click", () => {
            const values = getFormValues();
            const { configData } = buildConfigPayload(values);
            configJson.value = JSON.stringify(configData, null, 2);
          });
        }

        if (importConfigBtn && configJson) {
          importConfigBtn.addEventListener("click", () => {
            const raw = configJson.value.trim();
            if (!raw) {
              showError("Paste a configuration JSON before importing.");
              return;
            }

            try {
              const parsed = JSON.parse(raw);
              const config = parsed && parsed.configData ? parsed.configData : parsed;
              if (!config || typeof config !== "object") {
                showError("Invalid configuration JSON.");
                return;
              }
              applyConfigToForm(config);
              document.getElementById("manual-url").style.display = "none";
            } catch (error) {
              console.error("Config import error:", error);
              showError(`Invalid JSON: ${error.message}`);
            }
          });
        }

        if (copyConfigBtn && configJson) {
          copyConfigBtn.addEventListener("click", async () => {
            const raw = configJson.value.trim();
            if (!raw) {
              showError("Nothing to copy yet. Click Export first.");
              return;
            }

            try {
              await navigator.clipboard.writeText(raw);
            } catch (error) {
              console.error("Clipboard copy failed:", error);
              showError("Failed to copy configuration to clipboard.");
            }
          });
        }

        if (clearConfigBtn && configJson) {
          clearConfigBtn.addEventListener("click", () => {
            configJson.value = "";
          });
        }

        // Check if we're in edit mode (URL contains a config ID)
        const path = window.location.pathname;
        const isDirectAccess =
          path === "/aisearch/configure" || path === "/configure";
        const configIdMatch = isDirectAccess
          ? null
          : path.match(
              /\/aisearch\/([^\/]+)\/configure$|\/([^\/]+)\/configure$/
            );

        if (!isDirectAccess && configIdMatch) {
          // Get the config ID from whichever capture group matched
          const configId = configIdMatch[1] || configIdMatch[2];
          console.log("Editing existing configuration:", configId);

          // Fix image paths when in edit mode
          const basePath = path.startsWith("/aisearch") ? "/aisearch" : "";
          document.querySelector(".logo").src = `${basePath}/logo.png`;
          const bmcImg = document.querySelector(".bmc-button img");
          if (bmcImg) bmcImg.src = `${basePath}/bmc.png`;

          // Set the config ID to a hidden field
          document.getElementById("existingConfigId").value = configId;

          // Load the existing configuration
          const baseUrl = window.location.origin;
          const apiPath = path.startsWith("/aisearch") ? "/aisearch" : "";
          console.log(
            "Fetching config from:",
            `${baseUrl}${apiPath}/api/getConfig/${configId}`
          );

          fetch(`${baseUrl}${apiPath}/api/getConfig/${configId}`)
            .then((response) => {
              console.log(
                "Config fetch response:",
                response.status,
                response.statusText
              );
              if (!response.ok) {
                throw new Error(
                  `Failed to load configuration: ${response.status}`
                );
              }
              return response.json();
            })
            .then((config) => {
              console.log("Loaded configuration:", config);
              applyConfigToForm(config);
            })
            .catch((error) => {
              console.error("Error loading configuration:", error);
              showError(`Error: ${error.message}`);
              alert(
                "Failed to load the existing configuration. Please try again or create a new one."
              );
            });
        } else {
          // Direct access to /aisearch/configure
          // Fix image paths for direct access
          const basePath = path.startsWith("/aisearch") ? "/aisearch" : "";
          document.querySelector(".logo").src = `${basePath}/logo.png`;
          const bmcImg = document.querySelector(".bmc-button img");
          if (bmcImg) bmcImg.src = `${basePath}/bmc.png`;
        }
      });

window.addEventListener("message", async function (event) {
        if (event.origin !== window.location.origin) return;

        if (event.data.type === "TRAKT_AUTH_SUCCESS") {
          const { access_token, refresh_token, expires_in } = event.data;
          
          updateTraktStatus("Fetching user...", "#666", "Getting your Trakt.tv profile...");

          try {
            // New Step: Fetch the Trakt username
            const userResponse = await fetch("https://api.trakt.tv/users/me", {
              headers: {
                "Content-Type": "application/json",
                "trakt-api-version": "2",
                "trakt-api-key": TRAKT_CLIENT_ID,
                "Authorization": `Bearer ${access_token}`,
              },
            });

            if (!userResponse.ok) {
              throw new Error("Failed to fetch Trakt user profile.");
            }

            const userData = await userResponse.json();
            const username = userData.username;

            // Store all auth data in hidden fields
            document.getElementById("traktAccessToken").value = access_token;
            document.getElementById("traktRefreshToken").value = refresh_token;
            document.getElementById("traktExpiresIn").value = expires_in;
            document.getElementById("traktUsername").value = username;

            updateTraktStatus(
              `Connected as ${username}`,
              "#2a5a2a", // Green color for success
              `Successfully connected as <strong>${username}</strong>! Click 'Configure Addon' below to save.`
            );
          } catch (error) {
            console.error("Trakt user fetch error:", error);
            updateTraktStatus(
              "Authentication Error",
              "#e74c3c", // Red color for error
              "Could not verify your Trakt.tv account. Please try authenticating again."
            );
          }
        }
      });

      async function validateAndRefreshTraktToken() {
        const existingUsername = document.getElementById("traktUsername").value.trim();

        // This function now only runs in edit mode if a username is already set.
        if (existingUsername) {
            updateTraktStatus(
                `Connected as ${existingUsername}`,
                "#2a5a2a", // Green color
                `Your addon is connected to Trakt.tv as <strong>${existingUsername}</strong>. To change accounts, use the login button again.`
            );
            return;
        }

        const traktAccessToken = document.getElementById("traktAccessToken").value;
        if (!traktAccessToken) {
          updateTraktStatus(
            "Login with Trakt.tv",
            "#2a2a2a",
            "Connect your Trakt.tv account to get personalized movie recommendations based on your watch history and ratings."
          );
        }
      }

      function updateTraktStatus(buttonText, buttonColor, helpText) {
        const traktAuthBtn = document.getElementById("traktAuthBtn");
        const traktHelpText = document.querySelector(
          ".form-group:has(#traktAuthBtn) .help-text"
        );

        if (traktAuthBtn) {
          traktAuthBtn.textContent = buttonText;
          traktAuthBtn.style.backgroundColor = buttonColor;
        }

        if (traktHelpText) {
          traktHelpText.innerHTML = helpText;
        }
      }

      async function authenticateTrakt() {
        const formData = {
          geminiKey: document.getElementById("geminiKey").value,
          tmdbKey: document.getElementById("tmdbKey").value,
          rpdbKey: document.getElementById("rpdbKey").value,
          rpdbPosterType: document.getElementById("rpdbPosterType").value,
          tmdbLanguage: document.getElementById("tmdbLanguage").value,
          numResults: document.getElementById("numResults").value,
          enableAiCache: document.getElementById("enableAiCache").checked,
          showAdvancedOptions: document.getElementById("showAdvancedOptions")
            .checked,
          geminiModel: document.getElementById("geminiModel").value,
          traktAccessToken: document.getElementById("traktAccessToken").value,
          traktRefreshToken: document.getElementById("traktRefreshToken").value,
          enableRpdbPosters:
            document.getElementById("enableRpdbPosters").checked,
          enableHomepage: document.getElementById("enableHomepage").checked,
          homepageQuery: document.getElementById("homepageQuery").value,
          includeAdult: document.getElementById("includeAdult").checked,
          enableSimilar: document.getElementById("enableSimilar").checked,
        };
        sessionStorage.setItem("formData", JSON.stringify(formData));

        const redirectUri = `${window.location.origin}/aisearch/oauth/callback`;
        const state = Math.random().toString(36).substring(7);
        sessionStorage.setItem("traktOAuthState", state);

        const width = Math.min(600, window.screen.width * 0.9);
        const height = Math.min(800, window.screen.height * 0.9);
        const left = (window.screen.width - width) / 2;
        const top = (window.screen.height - height) / 2;

        const authUrl =
          `https://trakt.tv/oauth/authorize?` +
          `response_type=code` +
          `&client_id=${encodeURIComponent(TRAKT_CLIENT_ID)}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&state=${encodeURIComponent(state)}`;

        window.open(
          authUrl,
          "traktAuth",
          `width=${width},height=${height},left=${left},top=${top},toolbar=0,scrollbars=1,status=0,resizable=1,location=0,menuBar=0`
        );
      }

      // Restore form data when page loads
      document.addEventListener("DOMContentLoaded", function () {
        const savedFormData = sessionStorage.getItem("formData");
        if (savedFormData) {
          const formData = JSON.parse(savedFormData);
          document.getElementById("geminiKey").value = formData.geminiKey || "";
          document.getElementById("tmdbKey").value = formData.tmdbKey || "";
          document.getElementById("rpdbKey").value = formData.rpdbKey || "";
          document.getElementById("rpdbPosterType").value =
            formData.rpdbPosterType || "poster-default";
          document.getElementById("tmdbLanguage").value =
            formData.tmdbLanguage || "en-US";
          document.getElementById("numResults").value =
            formData.numResults || String(DEFAULT_NUM_RESULTS);
          document.getElementById("enableAiCache").checked =
            formData.enableAiCache !== false;
          if (formData.geminiModel)
            document.getElementById("geminiModel").value = formData.geminiModel;

          // NEW: Restore RPDB checkbox state
          document.getElementById("enableRpdbPosters").checked =
            formData.enableRpdbPosters !== false; // Default to true if not explicitly false
          // Call toggleRpdbFields *after* restoring state
          toggleRpdbFields();
          // Restore Homepage recommendation state
          document.getElementById("enableHomepage").checked =
            formData.enableHomepage !== false ? formData.enableHomepage : DEFAULT_ENABLE_HOMEPAGE;
          if (formData.homepageQuery) {
              document.getElementById("homepageQuery").value = formData.homepageQuery;
          }
          document.getElementById("includeAdult").checked = formData.includeAdult === true ? true : DEFAULT_INCLUDE_ADULT;
          document.getElementById("enableSimilar").checked =
            formData.enableSimilar !== false ? formData.enableSimilar : DEFAULT_ENABLE_SIMILAR;
          // Call toggleHomepageQueryVisibility *after* restoring state
          toggleHomepageQueryVisibility();
          // Restore Trakt token if it exists
          if (formData.traktAccessToken) {
            document.getElementById("traktAccessToken").value =
              formData.traktAccessToken;
            if (formData.traktRefreshToken) {
              document.getElementById("traktRefreshToken").value =
                formData.traktRefreshToken;
            }
            setTimeout(validateAndRefreshTraktToken, 100);
          }

          if (formData.showAdvancedOptions) {
            document.getElementById("showAdvancedOptions").checked = true;
            document.getElementById("advancedOptions").style.display = "block";
          }

          // Clear the saved form data
          sessionStorage.removeItem("formData");
        }
      });

      function openIssueModal() {
        const modal = document.getElementById("issueModal");
        modal.style.display = "block";

        // Pre-fill error details if any
        const errorDiv = document.getElementById("error");
        const errorDetails = document.getElementById("errorDetails");
        if (
          errorDiv &&
          errorDiv.style.display !== "none" &&
          errorDiv.textContent
        ) {
          errorDetails.value = errorDiv.textContent;
        }
      }

      function closeIssueModal() {
        const modal = document.getElementById("issueModal");
        modal.style.display = "none";
      }

      // Close modal when clicking outside
      window.onclick = function (event) {
        const modal = document.getElementById("issueModal");
        if (event.target === modal) {
          closeIssueModal();
        }
      };

      // Close modal when clicking X
      document.querySelector(".close-modal").onclick = closeIssueModal;

      function toggleIssueFields() {
        const feedbackType = document.getElementById("feedbackType").value;
        const issueFields = document.getElementById("issueFields");
        issueFields.style.display = feedbackType === "issue" ? "block" : "none";
      }

      function updateCommentsValidation() {
        const errorDetails = document
          .getElementById("errorDetails")
          .value.trim();
        const comments = document.getElementById("comments");
        const commentsRequired = document.getElementById("commentsRequired");

        if (errorDetails) {
          comments.required = false;
          commentsRequired.style.display = "none";
        } else {
          comments.required = true;
          commentsRequired.style.display = "inline";
        }
      }

      async function submitIssue(event) {
        event.preventDefault();

        const submitButton = document.querySelector(".submit-button");
        const feedbackContainer = document.getElementById("submitFeedback");
        submitButton.disabled = true;
        submitButton.textContent = "Submitting...";
        feedbackContainer.style.display = "none";

        try {
          const feedbackType = document.getElementById("feedbackType").value;
          const errorDetails = document
            .getElementById("errorDetails")
            .value.trim();
          const comments = document.getElementById("comments").value.trim();

          // For ideas, we only require comments
          if (feedbackType === "idea" && !comments) {
            showFeedback(
              "Please provide details about your idea in the comments section",
              false
            );
            return;
          }
          // For issues, we require either error details or comments
          if (feedbackType === "issue" && !errorDetails && !comments) {
            showFeedback(
              "Please provide either Error Details or Comments",
              false
            );
            return;
          }

          let recaptchaToken;
          try {
            // Wait for reCAPTCHA token with better error handling
            recaptchaToken = await new Promise((resolve) => {
              if (typeof grecaptcha === "undefined") {
                console.warn(
                  "reCAPTCHA not loaded, proceeding without verification"
                );
                resolve(null);
                return;
              }
              grecaptcha.ready(async () => {
                try {
                  const token = await grecaptcha.execute(
                    "6Lcq7-wqAAAAAECl1WKYOBhtSHVQhoWOOnZ_njlW",
                    { action: "submit_issue" }
                  );
                  resolve(token);
                } catch (error) {
                  console.warn("reCAPTCHA error:", error);
                  // Proceed without reCAPTCHA if there's an error
                  resolve(null);
                }
              });
            });
          } catch (error) {
            console.warn("Failed to get reCAPTCHA token:", error);
            recaptchaToken = null;
          }

          const formData = {
            feedbackType: feedbackType,
            title: document.getElementById("issueTitle").value.trim(),
            deviceType: document.getElementById("deviceType").value,
            browserType:
              document.getElementById("deviceType").value === "web"
                ? document.getElementById("browserType").value
                : null,
            errorDetails,
            comments,
            recaptchaToken: recaptchaToken,
          };

          console.log("Submitting form data:", formData);

          const response = await fetch(`/aisearch/submit-issue`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(formData),
          });

          const responseData = await response.json();
          console.log("Server response:", responseData);

          if (!response.ok) {
            throw new Error(
              responseData.error ||
                "Failed to submit feedback. Please try again."
            );
          }

          // Show success message
          showFeedback(
            `<p style="margin-bottom: 15px;">Thank you for your ${feedbackType}. Your feedback has been successfully submitted.</p>${
              responseData.issueUrl
                ? `<p style="margin-bottom: 10px;">You can track the status of your ${feedbackType} at: <a href="${responseData.issueUrl}" target="_blank">${responseData.issueUrl}</a></p>`
                : `<p style="margin-bottom: 0;">You can track all issues and ideas at <a href="https://github.com/itcon-pty-au/stremio-ai-search/issues" target="_blank">GitHub Issues</a></p>`
            }`,
            true
          );

          // Clear form fields
          document.getElementById("feedbackType").value = "issue";
          document.getElementById("issueTitle").value = "";
          document.getElementById("deviceType").value = "windows";
          document.getElementById("browserType").value = "chrome";
          document.getElementById("errorDetails").value = "";
          document.getElementById("comments").value = "";
        } catch (error) {
          console.error("Submission error:", error);
          showFeedback(
            error.message ||
              "An error occurred while submitting your feedback. Please try again.",
            false
          );
        } finally {
          submitButton.disabled = false;
          submitButton.textContent = "Submit";
        }
      }

      function showFeedback(message, isSuccess) {
        const feedbackContainer = document.getElementById("submitFeedback");
        feedbackContainer.innerHTML = message;
        feedbackContainer.className =
          "feedback-container " +
          (isSuccess ? "feedback-success" : "feedback-error");
        feedbackContainer.style.display = "block";
      }

      // Initialize issue fields visibility
      document.addEventListener("DOMContentLoaded", function () {
        toggleIssueFields();
      });

      function toggleBrowserSelect() {
        const deviceType = document.getElementById("deviceType").value;
        const browserContainer = document.getElementById(
          "browserSelectContainer"
        );
        const browserSelect = document.getElementById("browserType");
        const otherDeviceMessage =
          document.getElementById("otherDeviceMessage");

        if (deviceType === "web") {
          browserContainer.style.display = "block";
          browserSelect.required = true;
          otherDeviceMessage.style.display = "none";
        } else {
          browserContainer.style.display = "none";
          browserSelect.required = false;
          otherDeviceMessage.style.display =
            deviceType === "other" ? "block" : "none";
        }
      }

      // Toggle RPDB fields based on checkbox and API key tier
      function toggleRpdbFields() {
        const enableRpdb = document.getElementById("enableRpdbPosters").checked;
        const rpdbKeyGroup = document.getElementById("rpdbKeyGroup");
        const rpdbPosterTypeGroup = document.getElementById(
          "rpdbPosterTypeGroup"
        );
        const rpdbKey = document.getElementById("rpdbKey").value.trim();

        // Show/hide the key input field based on the checkbox
        rpdbKeyGroup.style.display = enableRpdb ? "block" : "none";

        // Determine if we should show the poster type dropdown
        // Only show if RPDB is enabled AND a valid non-tier-0 key is entered
        const isTier0Key = rpdbKey.startsWith("t0-");
        const isValidNonTier0Key = /^t[1-9]\d*-/.test(rpdbKey); // Matches t1-, t2-, etc.
        const shouldShowPosterType = enableRpdb && isValidNonTier0Key;

        // Always hide poster type by default, only show for valid non-t0 keys
        rpdbPosterTypeGroup.style.display = shouldShowPosterType
          ? "block"
          : "none";

        // If using a tier 0 key or no key, set poster type to default
        if (!shouldShowPosterType && enableRpdb) {
          document.getElementById("rpdbPosterType").value = "poster-default";
        }

        // Clear the key if disabled
        if (!enableRpdb) {
          document.getElementById("rpdbKey").value = "";
        }

        // Clear the manual URL display when changing RPDB settings
        document.getElementById("manual-url").style.display = "none";
      }

      // Add event listener for the new checkbox
      document
        .getElementById("enableRpdbPosters")
        .addEventListener("change", toggleRpdbFields);

      // Add event listener for the RPDB API key input to check tier
      document
        .getElementById("rpdbKey")
        .addEventListener("input", toggleRpdbFields);

      // Call toggleRpdbFields on load in case the checkbox is pre-checked (e.g., during edit)
      toggleRpdbFields();

      // Ensure RPDB poster type is hidden initially
      document.addEventListener("DOMContentLoaded", function () {
        // Hide the poster type by default
        document.getElementById("rpdbPosterTypeGroup").style.display = "none";

        // Make sure toggleRpdbFields is called after loading configurations
        const existingConfig =
          document.getElementById("existingConfigId").value;
        if (existingConfig) {
          // Wait a bit to ensure config has loaded before checking fields
          setTimeout(toggleRpdbFields, 500);
        }
      });
    
