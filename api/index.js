const app = require("../backend/server");

function handler(req, res) {
	if (req.url === "/api" || req.url.startsWith("/api/")) {
		req.url = req.url.slice(4) || "/";
	}

	return app(req, res);
}

module.exports = handler;
