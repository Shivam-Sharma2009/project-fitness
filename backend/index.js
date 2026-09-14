const { onRequest } = require("firebase-functions/v2/https");
const app = require("./server");

exports.api = onRequest({
	region: "us-central1",
	secrets: ["FIREBASE_WEB_API_KEY"]
}, app);
