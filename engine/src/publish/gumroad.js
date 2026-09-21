/**
 * Gumroad publishing. This is the leg that genuinely automates end to end.
 *
 * Flow: create the product, upload the EPUB via S3 multipart, attach it,
 * then publish. Requires GUMROAD_ACCESS_TOKEN.
 *
 * Every call here is a real, irreversible action against a live storefront, so
 * the pipeline only reaches this code after an explicit human approval.
 */
const API = "https://api.gumroad.com/v2";

function token() {
  const value = process.env.GUMROAD_ACCESS_TOKEN;
  if (!value) {
    throw new Error(
      "GUMROAD_ACCESS_TOKEN is not set. Create one at gumroad.com/settings/advanced " +
        "and export it before publishing.",
    );
  }
  return value;
}

async function call(path, { method = "GET", body } = {}) {
  const url = new URL(`${API}${path}`);
  const init = { method, headers: {} };

  if (body) {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined && value !== null) form.append(key, String(value));
    }
    form.append("access_token", token());
    init.body = form;
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
  } else {
    url.searchParams.set("access_token", token());
  }

  const response = await fetch(url, init);
  const text = await response.text();

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Gumroad returned non-JSON (${response.status}): ${text.slice(0, 200)}`);
  }

  if (!response.ok || payload.success === false) {
    throw new Error(`Gumroad ${method} ${path} failed (${response.status}): ${payload.message || text.slice(0, 200)}`);
  }
  return payload;
}

/**
 * Publishes a finished book. `epubPath` must exist; `book` is the manifest entry.
 * Returns { productId, url }.
 */
export async function publishToGumroad({ book, epubBuffer, epubName, dryRun = false }) {
  const priceCents = Math.round(book.listing.priceUsd * 100);

  const payload = {
    name: book.title,
    description: `${book.listing.description}\n\n${book.aiDisclosure}`,
    price: priceCents,
    customizable_price: false,
  };

  if (dryRun) {
    return {
      dryRun: true,
      wouldCreate: payload,
      fileBytes: epubBuffer.length,
      fileName: epubName,
    };
  }

  const created = await call("/products", { method: "POST", body: payload });
  const product = created.product;

  // The file upload is a separate multipart flow against Gumroad's S3 bucket.
  const upload = await uploadFile({ productId: product.id, buffer: epubBuffer, name: epubName });

  await call(`/products/${product.id}`, {
    method: "PUT",
    body: { "file_url[]": upload.fileUrl },
  });

  await call(`/products/${product.id}/enable`, { method: "PUT" });

  return { productId: product.id, url: product.short_url, fileUrl: upload.fileUrl };
}

/**
 * S3 multipart upload. Gumroad presigns each 100MB part; we hold the ETags and
 * complete the upload, then hand the resulting file_url back to the product.
 */
async function uploadFile({ productId, buffer, name }) {
  const PART = 100 * 1024 * 1024;
  const parts = Math.max(1, Math.ceil(buffer.length / PART));

  const presigned = await call("/uploads/presign", {
    method: "POST",
    body: { product_id: productId, file_name: name, parts, content_type: "application/epub+zip" },
  });

  const etags = [];
  for (let i = 0; i < parts; i++) {
    const chunk = buffer.subarray(i * PART, Math.min((i + 1) * PART, buffer.length));
    const response = await fetch(presigned.urls[i], { method: "PUT", body: chunk });
    if (!response.ok) {
      throw new Error(`Upload part ${i + 1}/${parts} failed (${response.status}).`);
    }
    etags.push(response.headers.get("etag"));
  }

  const completed = await call("/uploads/complete", {
    method: "POST",
    body: { upload_id: presigned.upload_id, etags: JSON.stringify(etags) },
  });

  return { fileUrl: completed.file_url };
}

/**
 * Lists the products already on sale in the connected Gumroad account.
 *
 * This is how a catalogue that was published by hand gets reconciled with the
 * dashboard: Gumroad knows what is live, so ask it rather than retyping.
 * Amazon and KDP have no equivalent - there is no API to ask.
 */
export async function listGumroadProducts() {
  const payload = await call("/products");
  const products = Array.isArray(payload.products) ? payload.products : [];

  return products.map((product) => ({
    id: product.id,
    title: product.name,
    url: product.short_url,
    published: product.published === true,
    priceUsd: typeof product.price === "number" ? product.price / 100 : null,
    sales: product.sales_count ?? null,
    revenueUsd: typeof product.sales_usd_cents === "number" ? product.sales_usd_cents / 100 : null,
  }));
}
