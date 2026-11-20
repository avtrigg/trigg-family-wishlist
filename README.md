# Trigg Family Wishlist

An invite-only family gift list. Family members can create recipient profiles, browse wishlists, and add gifts to their own lists. A separate Purchases tab lets other family members coordinate. The recipient's account cannot read the purchase endpoint or change its records.

## Accounts and sharing

The recipient email on a profile must match their ChatGPT sign-in email. A profile links a wishlist to an account. Site access is granted separately through Sites sharing. Keep the published Site restricted to the family and add relatives as viewers.

## Build and test

Use Node.js 24 or newer. The project has no npm dependencies.

```sh
npm test
```

The build creates the Worker at `dist/server/index.js`. The Sites hosting manifest binds the `DB` D1 database. Sites applies the SQL in `drizzle/` during publishing.

Deploy through the corresponding private Sites project. The Worker relies on Sites to supply trusted, authenticated account headers. Hosting it directly without equivalent identity verification would remove the protection on purchases.
