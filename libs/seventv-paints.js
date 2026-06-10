// 7TV nametag paints for Twitch chatters.
// Looks up a chatter's active 7TV paint (linear/radial gradient or image)
// and applies it to a username element using CSS background-clip: text.
// Paint data model mirrors the 7TV v3 API: function, color, angle, repeat,
// stops [{at, color}], shadows [{x_offset, y_offset, radius, color}], image_url.
(function (global) {
	"use strict";

	var SEVENTV_GQL = "https://7tv.io/v3/gql";
	var TWITCH_ID_LOOKUP = "https://api.socialstream.ninja/twitch/user?username=";

	var PAINT_TTL = 30 * 60 * 1000; // re-check a user's paint every 30 minutes
	var MISS_TTL = 10 * 60 * 1000; // users without a paint re-checked sooner
	var UID_TTL = 7 * 24 * 60 * 60 * 1000; // twitch login -> id mapping
	var STORAGE_PREFIX = "seventvPaint.";

	var memCache = {};
	var inflight = {};

	function readStore(key) {
		try {
			var raw = localStorage.getItem(STORAGE_PREFIX + key);
			if (!raw) {
				return null;
			}
			var item = JSON.parse(raw);
			if (!item || !item.expiry || item.expiry < Date.now()) {
				localStorage.removeItem(STORAGE_PREFIX + key);
				return null;
			}
			return item;
		} catch (e) {
			return null;
		}
	}

	function writeStore(key, value, ttl) {
		try {
			localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify({ value: value, expiry: Date.now() + ttl }));
		} catch (e) {}
	}

	// 7TV packs colors as a 32-bit RGBA integer (may arrive signed).
	function rgbaString(color) {
		var u = color >>> 0;
		var r = (u >>> 24) & 0xff;
		var g = (u >>> 16) & 0xff;
		var b = (u >>> 8) & 0xff;
		var a = (u & 0xff) / 255;
		return "rgba(" + r + ", " + g + ", " + b + ", " + (Math.round(a * 1000) / 1000) + ")";
	}

	function stopsToCss(stops) {
		var parts = [];
		for (var i = 0; i < stops.length; i++) {
			var stop = stops[i];
			if (!stop || typeof stop.at !== "number" || typeof stop.color !== "number") {
				continue;
			}
			parts.push(rgbaString(stop.color) + " " + Math.round(stop.at * 10000) / 100 + "%");
		}
		return parts.join(", ");
	}

	function shadowsToCss(shadows) {
		var parts = [];
		for (var i = 0; i < shadows.length; i++) {
			var s = shadows[i];
			if (!s) {
				continue;
			}
			parts.push("drop-shadow(" + (s.x_offset || 0) + "px " + (s.y_offset || 0) + "px " + (s.radius || 0) + "px " + rgbaString(s.color || 0) + ")");
		}
		return parts.join(" ");
	}

	function paintToCss(paint) {
		if (!paint) {
			return null;
		}
		var fn = String(paint["function"] || "").toUpperCase();
		var stops = stopsToCss(paint.stops || []);
		var css = { backgroundImage: "", backgroundColor: "", backgroundSize: "100% 100%", filter: "", name: paint.name || "" };

		if (fn === "LINEAR_GRADIENT" && stops) {
			var angle = typeof paint.angle === "number" ? paint.angle : 90;
			css.backgroundImage = (paint.repeat ? "repeating-linear-gradient(" : "linear-gradient(") + angle + "deg, " + stops + ")";
		} else if (fn === "RADIAL_GRADIENT" && stops) {
			var shape = paint.shape ? String(paint.shape).toLowerCase() : "circle";
			css.backgroundImage = (paint.repeat ? "repeating-radial-gradient(" : "radial-gradient(") + shape + ", " + stops + ")";
		} else if (fn === "URL" && paint.image_url) {
			css.backgroundImage = "url('" + String(paint.image_url).replace(/'/g, "%27") + "')";
			css.backgroundSize = "cover";
			if (typeof paint.color === "number") {
				css.backgroundColor = rgbaString(paint.color);
			}
		} else if (typeof paint.color === "number") {
			var flat = rgbaString(paint.color);
			css.backgroundImage = "linear-gradient(0deg, " + flat + ", " + flat + ")";
		}

		if (!css.backgroundImage) {
			return null;
		}
		if (paint.shadows && paint.shadows.length) {
			css.filter = shadowsToCss(paint.shadows);
		}
		return css;
	}

	function applyPaint(ele, css) {
		if (!ele || !css || !css.backgroundImage) {
			return;
		}
		ele.style.backgroundImage = css.backgroundImage;
		if (css.backgroundColor) {
			ele.style.backgroundColor = css.backgroundColor;
		}
		ele.style.backgroundSize = css.backgroundSize || "100% 100%";
		ele.style.backgroundPosition = "center";
		ele.style.backgroundRepeat = "no-repeat";
		ele.style.setProperty("background-clip", "text");
		ele.style.setProperty("-webkit-background-clip", "text");
		// Keep the color property untouched so currentColor badges/SVGs still render;
		// only the glyph fill goes transparent so the paint shows through.
		ele.style.setProperty("-webkit-text-fill-color", "transparent");
		if (css.filter) {
			ele.style.filter = css.filter;
		}
		if (css.name) {
			ele.title = css.name;
		}
		ele.classList.add("seventv-paint");
	}

	function fetchJson(url, options) {
		return fetch(url, options).then(function (response) {
			if (!response.ok) {
				throw new Error("HTTP " + response.status);
			}
			return response.json();
		});
	}

	function resolveTwitchId(username) {
		var stored = readStore("uid." + username);
		if (stored && stored.value) {
			return Promise.resolve(stored.value);
		}
		return fetchJson(TWITCH_ID_LOOKUP + encodeURIComponent(username)).then(function (data) {
			var id = data && data.data && data.data[0] && data.data[0].id ? String(data.data[0].id) : "";
			if (id) {
				writeStore("uid." + username, id, UID_TTL);
			}
			return id;
		});
	}

	function fetchPaintByTwitchId(userId) {
		var query = "query GetUserPaint($id: String!) { userByConnection(platform: TWITCH, id: $id) { id style { paint { id name function color angle shape image_url repeat stops { at color } shadows { x_offset y_offset radius color } } } } }";
		return fetchJson(SEVENTV_GQL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: query, variables: { id: String(userId) } })
		}).then(function (json) {
			var user = json && json.data && json.data.userByConnection;
			return (user && user.style && user.style.paint) || null;
		});
	}

	function getPaintCssForTwitchUser(opts) {
		opts = opts || {};
		var userId = opts.userId ? String(opts.userId) : "";
		var username = String(opts.username || "").trim().toLowerCase();
		// Twitch logins are ascii word characters; strips localized display names.
		username = username.replace(/[^a-z0-9_]/g, "");
		if (!userId && !username) {
			return Promise.resolve(null);
		}

		var cacheKey = userId ? "id." + userId : "login." + username;
		var cached = memCache[cacheKey];
		if (cached && cached.expiry > Date.now()) {
			return Promise.resolve(cached.value);
		}
		var stored = readStore("css." + cacheKey);
		if (stored) {
			memCache[cacheKey] = { value: stored.value, expiry: stored.expiry };
			return Promise.resolve(stored.value);
		}
		if (inflight[cacheKey]) {
			return inflight[cacheKey];
		}

		var idPromise = userId ? Promise.resolve(userId) : resolveTwitchId(username);
		var promise = idPromise
			.then(function (id) {
				if (!id) {
					return null;
				}
				return fetchPaintByTwitchId(id);
			})
			.then(function (paint) {
				var css = paintToCss(paint);
				var ttl = css ? PAINT_TTL : MISS_TTL;
				memCache[cacheKey] = { value: css, expiry: Date.now() + ttl };
				writeStore("css." + cacheKey, css, ttl);
				delete inflight[cacheKey];
				return css;
			})
			.catch(function () {
				// Network or API failure; back off briefly without caching to disk.
				memCache[cacheKey] = { value: null, expiry: Date.now() + 60 * 1000 };
				delete inflight[cacheKey];
				return null;
			});

		inflight[cacheKey] = promise;
		return promise;
	}

	function applyToElement(ele, opts) {
		if (!ele) {
			return Promise.resolve(null);
		}
		return getPaintCssForTwitchUser(opts).then(function (css) {
			if (css) {
				applyPaint(ele, css);
			}
			return css;
		});
	}

	global.SeventvPaints = {
		paintToCss: paintToCss,
		applyPaint: applyPaint,
		getPaintCssForTwitchUser: getPaintCssForTwitchUser,
		applyToElement: applyToElement
	};
})(window);
