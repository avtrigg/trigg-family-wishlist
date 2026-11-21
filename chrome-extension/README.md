# Add to Family Wishlist

1. Run the current wishlist app with `npm start`.
2. In Chrome, open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select this folder, the one containing `manifest.json`.
4. Open a product page, then click **Add to Family Wishlist** in Chrome’s extensions menu.
5. Check the captured name, price, and image, then click **Add to wishlist**. Review the prefilled item in the wishlist and click **Add item** to save it.

The extension defaults to `http://localhost:3000`. For a hosted wishlist, change **Wishlist address** in the extension popup. Each browser can keep its own address. If you’re signed out, the app keeps the draft in that tab while you sign in.

The extension only reads a page after you open the popup. Amazon product fields, structured product data, and common page metadata are supported. If the page doesn’t show a price or an image, you can fill in the missing information before saving.
