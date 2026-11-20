# Trigg Family Wishlist

A shared family wishlist. Recipients can add, edit, and remove wishes. Other family members can claim wishes or record gifts they already bought. The recipient never receives claim information or purchased gifts through the wishlist API.

## Run locally

Use Node.js 24 or newer. The app uses Node's built-in SQLite and has no npm dependencies.

```sh
npm test
npm start
```

Open http://localhost:3000. Create a username and password to try the site. For a second user, open a private browsing window and create another account.

## Sign in with Google

Copy `.env.example` to `.env`. Create a Google OAuth client of type **Web application** and register the exact redirect URI `http://localhost:3000/auth/google/callback` for local use. For production, register the deployed HTTPS origin followed by `/auth/google/callback`. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on the server. Google buttons become available when both are set.

See the [Google OAuth web server setup](https://developers.google.com/identity/protocols/oauth2/web-server).

## Wishlist ownership

Creating a list for yourself links it to your account. Each account can own one wishlist. When you create a list for someone else, you can manage their wish items until they own the list. If you supply an email that matches a verified Gmail or Google Workspace account, the app links the list when that person creates their Google account. It also recognizes matching Google accounts that already exist. Email is optional and the app does not send email. Username-only accounts can create and own a personal list directly.

## Deploy

Run `npm start` on a Node.js host with a persistent volume for `DATABASE_PATH`. Set `NODE_ENV=production`, `APP_ORIGIN` to the public HTTPS origin, and `FAMILY_ACCESS_CODE` to a random shared value of at least 16 characters. New accounts use this code. Configure your host's HTTPS reverse proxy and set `HOST` and `PORT` according to its routing. Keep the SQLite file and `.env` outside public static directories and out of source control. Use one server process and back up the data volume.

Product lookup fetches public HTTPS product pages on the server. It reads Amazon’s main product image and current price, and other retailers’ structured product and Open Graph metadata. HTTPS redirects are checked at each hop. If a store blocks the request, omits a price, or only loads details with JavaScript, you can save the link and enter the missing details by hand.
