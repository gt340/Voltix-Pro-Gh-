# Voltix Pro GH

Ghana's premium earpods e-commerce store — genuine quality, real prices, delivered nationwide.

**Live site:** https://voltix-pro-gh.vercel.app

## Tech stack

- Static multi-page HTML/CSS/JS (no build step, no framework)
- **Firebase** (Firestore + Auth + Storage) for products, orders, reviews, referrals, and admin login
- **Cloudinary** for image/video/audio hosting and on-the-fly optimization (`f_auto,q_auto` + sized transforms)
- **Paystack** for checkout payments
- Hosted on **Vercel**, deployed from this GitHub repo

## Pages

| File | Purpose |
|---|---|
| `index.html` | Landing/splash screen with the 3D brand viewer |
| `home.html` | Standalone all-in-one store experience (Shop / Design Lab / Ad Studio / Founder tabs) |
| `shop.html` | Main product grid — search, filter, sort |
| `product.html` | Single product detail page (`?id=`) — gallery, variants, reviews, add to cart / buy now |
| `showcase.html` | 3D-style product carousel |
| `cart.html` | Shopping cart |
| `checkout.html` | Checkout + Paystack payment |
| `orders.html` / `orders-success.html` | Order history / post-purchase confirmation |
| `track-order.html` | Look up an order by reference, no login required |
| `wishlist.html` | Saved/wishlisted products |
| `account.html` / `profile.html` / `settings.html` | Customer account management |
| `notifications.html` | Customer notifications |
| `about.html` / `contact.html` / `help.html` | Static info pages |
| `spin.html` | Spin-to-win coin/discount game |
| `admin.html` | Store owner dashboard (products, orders, reviews, referrals, spin winners, music, hero/founder media) — **not linked from anywhere in the public site; keep the URL private** |
| `app.js` | Shared logic: Firebase/Firestore wrapper (`VDB`), cart, wishlist, product cards, music player, image optimization |
| `style.css` | Shared design system (colors, components, layout) |

## Data model (Firestore collections)

- `products` — id, name, price, oldPrice, images[], variants[] (name, price, sku, images[]), specs, stock, badge
- `orders` — customer, items[], status, ref, createdAt
- `reviews` — productId, name, rating, comment, photo, approved (moderated in admin before showing publicly)
- `referrers` / `referralSales` — affiliate/referral program (commission tiers below)
- `categories` — shop category list
- `spinWinners` / `spinReferrals` — Spin & Win game results
- `settings/store` — hero media, founder media, promo banner, music playlist

## Referral commissions

| Price (Ghc) | Commission (Ghc) |
|---|---|
| 40 | 5 |
| 120 | 7 |
| 130 | 7 |
| 220 | 10 |

## Configuration

Firebase and Cloudinary config live directly in `app.js` (Firebase web config and an unsigned Cloudinary upload preset — both safe to expose client-side; access control is enforced by Firestore/Storage security rules, not by hiding these values).

Before taking real payments, swap the Paystack key in `checkout.html` from test mode to your live public key.

## SEO

- `robots.txt` allows public/shop pages and disallows account, cart, checkout, and admin pages.
- `sitemap.xml` lists the static public pages. Product pages (`product.html?id=...`) are dynamic and aren't in the static sitemap — ask if you'd like a small serverless function added to generate per-product sitemap entries automatically from Firestore.

## Support

WhatsApp: +233 53 619 3862
