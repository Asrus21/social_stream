// 7TV nametag paints for Twitch chatters.
// Looks up a chatter's active 7TV paint and applies it to a username element
// using CSS background-clip: text.
// Primary source is the 7TV v4 GraphQL API (users.userByConnection ->
// style.activePaint -> data.layers/shadows); the legacy v3 GraphQL API is
// kept as a fallback. Multi-layer v4 paints become comma-separated CSS
// background images.
(function (global) {
	"use strict";

	var SEVENTV_GQL_V4 = "https://7tv.io/v4/gql";
	var SEVENTV_GQL_V3 = "https://7tv.io/v3/gql";
	var TWITCH_ID_LOOKUP = "https://api.socialstream.ninja/twitch/user?username=";

	var PAINT_TTL = 30 * 60 * 1000; // re-check a user's paint every 30 minutes
	var MISS_TTL = 10 * 60 * 1000; // users without a paint re-checked sooner
	var UID_TTL = 7 * 24 * 60 * 60 * 1000; // twitch login -> id mapping
	var STORAGE_PREFIX = "seventvPaint2."; // bump to invalidate older cached formats

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

	// Legacy v3 packs colors as a 32-bit RGBA integer (may arrive signed).
	function rgbaString(color) {
		var u = color >>> 0;
		var r = (u >>> 24) & 0xff;
		var g = (u >>> 16) & 0xff;
		var b = (u >>> 8) & 0xff;
		var a = (u & 0xff) / 255;
		return "rgba(" + r + ", " + g + ", " + b + ", " + (Math.round(a * 1000) / 1000) + ")";
	}

	// v4 colors arrive as objects: { hex: "#RRGGBBAA", r, g, b, a }.
	function v4ColorString(color) {
		if (!color) {
			return "rgba(0, 0, 0, 0)";
		}
		if (color.hex) {
			return color.hex;
		}
		if (typeof color.r === "number") {
			return "rgba(" + color.r + ", " + color.g + ", " + color.b + ", " + (typeof color.a === "number" ? Math.round((color.a / 255) * 1000) / 1000 : 1) + ")";
		}
		return "rgba(0, 0, 0, 0)";
	}

	function stopsToCssV3(stops) {
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

	function stopsToCssV4(stops) {
		var parts = [];
		for (var i = 0; i < stops.length; i++) {
			var stop = stops[i];
			if (!stop || typeof stop.at !== "number") {
				continue;
			}
			parts.push(v4ColorString(stop.color) + " " + Math.round(stop.at * 10000) / 100 + "%");
		}
		return parts.join(", ");
	}

	function pickLayerImage(images) {
		if (!images || !images.length) {
			return "";
		}
		var best = null;
		for (var i = 0; i < images.length; i++) {
			var img = images[i];
			if (!img || !img.url) {
				continue;
			}
			if (!best) {
				best = img;
				continue;
			}
			var bestWebp = String(best.mime || "").indexOf("webp") !== -1;
			var imgWebp = String(img.mime || "").indexOf("webp") !== -1;
			if (imgWebp && !bestWebp) {
				best = img;
			} else if (imgWebp === bestWebp && (img.scale || 0) > (best.scale || 0) && (img.scale || 0) <= 2) {
				best = img;
			}
		}
		return best ? best.url : "";
	}

	// Converts a v4 paint (data.layers + data.shadows) to CSS.
	function paintV4ToCss(paint) {
		if (!paint || !paint.data) {
			return null;
		}
		var layers = paint.data.layers || [];
		var images = [];
		var sizes = [];

		for (var i = 0; i < layers.length; i++) {
			var layer = layers[i];
			var ty = layer && layer.ty;
			if (!ty || layer.opacity === 0) {
				continue;
			}
			var kind = ty.__typename || "";
			if (kind === "PaintLayerTypeSingleColor" && ty.color) {
				var flat = v4ColorString(ty.color);
				images.push("linear-gradient(0deg, " + flat + ", " + flat + ")");
				sizes.push("100% 100%");
			} else if (kind === "PaintLayerTypeLinearGradient") {
				var lstops = stopsToCssV4(ty.stops || []);
				if (lstops) {
					var angle = typeof ty.angle === "number" ? ty.angle : 90;
					images.push((ty.repeating ? "repeating-linear-gradient(" : "linear-gradient(") + angle + "deg, " + lstops + ")");
					sizes.push("100% 100%");
				}
			} else if (kind === "PaintLayerTypeRadialGradient") {
				var rstops = stopsToCssV4(ty.stops || []);
				if (rstops) {
					var shape = String(ty.shape || "circle").toLowerCase();
					images.push((ty.repeating ? "repeating-radial-gradient(" : "radial-gradient(") + shape + ", " + rstops + ")");
					sizes.push("100% 100%");
				}
			} else if (kind === "PaintLayerTypeImage") {
				var url = pickLayerImage(ty.images);
				if (url) {
					images.push("url('" + String(url).replace(/'/g, "%27") + "')");
					sizes.push("cover");
				}
			}
		}

		if (!images.length) {
			return null;
		}

		// CSS paints the first background on top; 7TV layers go bottom-up.
		images.reverse();
		sizes.reverse();

		var css = {
			backgroundImage: images.join(", "),
			backgroundColor: "",
			backgroundSize: sizes.join(", "),
			filter: "",
			name: paint.name || ""
		};

		var shadows = paint.data.shadows || [];
		var filters = [];
		for (var j = 0; j < shadows.length; j++) {
			var s = shadows[j];
			if (!s) {
				continue;
			}
			filters.push("drop-shadow(" + (s.offsetX || 0) + "px " + (s.offsetY || 0) + "px " + (s.blur || 0) + "px " + v4ColorString(s.color) + ")");
		}
		css.filter = filters.join(" ");
		return css;
	}

	// Converts a legacy v3 paint (function/stops/shadows) to CSS.
	function paintToCss(paint) {
		if (!paint) {
			return null;
		}
		var fn = String(paint["function"] || "").toUpperCase();
		var stops = stopsToCssV3(paint.stops || []);
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
			var filters = [];
			for (var i = 0; i < paint.shadows.length; i++) {
				var s = paint.shadows[i];
				if (!s) {
					continue;
				}
				filters.push("drop-shadow(" + (s.x_offset || 0) + "px " + (s.y_offset || 0) + "px " + (s.radius || 0) + "px " + rgbaString(s.color || 0) + ")");
			}
			css.filter = filters.join(" ");
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

	function fetchPaintCssV4(userId) {
		var query =
			"query PaintByConnection($platformId: String!) { users { userByConnection(platform: TWITCH, platformId: $platformId) { id style { activePaint { id name data { layers { id opacity ty { __typename ... on PaintLayerTypeSingleColor { color { hex } } ... on PaintLayerTypeLinearGradient { angle repeating stops { at color { hex } } } ... on PaintLayerTypeRadialGradient { repeating shape stops { at color { hex } } } ... on PaintLayerTypeImage { images { url mime scale } } } } shadows { color { hex } offsetX offsetY blur } } } } } } }";
		return fetchJson(SEVENTV_GQL_V4, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: query, variables: { platformId: String(userId) } })
		}).then(function (json) {
			if (!json || !json.data || !json.data.users) {
				throw new Error("7TV v4 GQL: unexpected response");
			}
			var user = json.data.users.userByConnection;
			var paint = user && user.style && user.style.activePaint;
			return paintV4ToCss(paint);
		});
	}

	function fetchPaintCssV3(userId) {
		var query = "query GetUserPaint($id: String!) { userByConnection(platform: TWITCH, id: $id) { id style { paint { id name function color angle shape image_url repeat stops { at color } shadows { x_offset y_offset radius color } } } } }";
		return fetchJson(SEVENTV_GQL_V3, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: query, variables: { id: String(userId) } })
		}).then(function (json) {
			if (!json || !json.data) {
				throw new Error("7TV v3 GQL: unexpected response");
			}
			var user = json.data.userByConnection;
			return paintToCss(user && user.style && user.style.paint);
		});
	}

	function fetchPaintCssById(userId) {
		return fetchPaintCssV4(userId).catch(function (errV4) {
			return fetchPaintCssV3(userId).catch(function (errV3) {
				console.warn("SeventvPaints: v4 lookup failed (" + errV4.message + "); v3 fallback failed (" + errV3.message + ")");
				throw errV3;
			});
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
				return fetchPaintCssById(id);
			})
			.then(function (css) {
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
		paintV4ToCss: paintV4ToCss,
		applyPaint: applyPaint,
		getPaintCssForTwitchUser: getPaintCssForTwitchUser,
		applyToElement: applyToElement
	};
})(window);
