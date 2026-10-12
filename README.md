# PhoneBandhu

PhoneBandhu storefront and admin dashboard with an Express/MongoDB API.

## Run the backend

1. Open a terminal in `backend` and run `npm install`.
2. Copy `.env.example` to `.env` and set `MONGO_URI` to your MongoDB connection string.
3. Start the API with `npm start` (default port: 5200).
4. Serve the project root with a local static web server and open `index.html`.

Never commit `.env` or share its contents. The checked-in `.env.example` contains placeholders only.
