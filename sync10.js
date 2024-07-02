const axios = require("axios");
const dotenv = require("dotenv");

dotenv.config();

const apiBaseUrl = process.env.WP_API_BASE_URL;
const username = process.env.WP_USERNAME;
const password = process.env.WP_PASSWORD;
const token = Buffer.from(`${username}:${password}`, "utf8").toString("base64");

const bearerToken = "35|fMhq0fRmnqzLeP9Vcij1A3oUJ6QNpq5QkU4vMYiE";

// Schedule the task to run every 12 hours
const FETCH_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours in milliseconds
setInterval(handlePropertyListings, FETCH_INTERVAL);

const MAX_RETRIES = 50;
const INITIAL_DELAY = 1000; // 1 second

// Function to introduce a delay
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Function to make API request with retry mechanism
async function makeRequestWithRetry(
  url,
  options,
  retries = MAX_RETRIES,
  delayMs = INITIAL_DELAY
) {
  try {
    return await axios.get(url, options);
  } catch (error) {
    if (retries > 0) {
      const rateLimitReset = error.response.headers["x-ratelimit-reset"];
      const retryAfter = error.response.headers["retry-after"] * 1000; // retry-after is in seconds, convert to ms
      const delayTime = retryAfter || delayMs;

      console.warn(
        `Rate limit hit, retrying in ${delayTime / 1000} seconds...`
      );
      await delay(delayTime);
      return makeRequestWithRetry(url, options, retries - 1, delayTime * 2); // Exponential backoff if retry-after not available
    } else {
      throw error;
    }
  }
}

// Function to fetch and process property listings from multiple URLs
async function fetchPropertyListings() {
  const urls = [
    "https://publicapi.myatrealty.com/api/v1/listings?filter[status][]=active",
    "https://publicapi.myatrealty.com/api/v1/listings?filter[status][]=current",
    "https://publicapi.myatrealty.com/api/v1/listings?filter[status][]=under offer",
    "https://publicapi.myatrealty.com/api/v1/listings?filter[status][]=sold"
  ];

  for (const url of urls) {
    try {
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${bearerToken}`,
        },
      });

      const properties = response.data.data;

      for (const property of properties) {
        await storeIds([property.id]);
        await delay(1000); // Introduce a 1 second delay between requests
      }
    } catch (error) {
      console.error(`Error fetching property listings from ${url}:`, error);
    }
  }
}

// Function to fetch and process property details and listing details
async function storeIds(ids) {
  for (const propertyID of ids) {
    try {
      const [
        propertyDetailsResponse,
        listingResponse,
        locationResponse,
        advertisementResponse,
        featuresResponse,
        galleryResponse,
        inspectionsResponse,
        documentsResponse,
      ] = await Promise.all([
        makeRequestWithRetry(
          `https://publicapi.myatrealty.com/api/v1/property-details/${propertyID}`,
          {
            headers: {
              Authorization: `Bearer ${bearerToken}`,
            },
          }
        ),
        makeRequestWithRetry(
          `https://publicapi.myatrealty.com/api/v1/listings/${propertyID}`,
          {
            headers: {
              Authorization: `Bearer ${bearerToken}`,
            },
          }
        ),
        makeRequestWithRetry(
          `https://publicapi.myatrealty.com/api/v1/listings/${propertyID}/property`,
          {
            headers: {
              Authorization: `Bearer ${bearerToken}`,
            },
          }
        ),
        makeRequestWithRetry(
          `https://publicapi.myatrealty.com/api/v1/listings/${propertyID}/advertisements`,
          {
            headers: {
              Authorization: `Bearer ${bearerToken}`,
            },
          }
        ),
        makeRequestWithRetry(
          `https://publicapi.myatrealty.com/api/v1/listings/${propertyID}/features`,
          {
            headers: {
              Authorization: `Bearer ${bearerToken}`,
            },
          }
        ),
        makeRequestWithRetry(
          `https://publicapi.myatrealty.com/api/v1/listings/${propertyID}/images`,
          {
            headers: {
              Authorization: `Bearer ${bearerToken}`,
            },
          }
        ),
        makeRequestWithRetry(
          `https://publicapi.myatrealty.com/api/v1/listings/${propertyID}/inspections`,
          {
            headers: {
              Authorization: `Bearer ${bearerToken}`,
            },
          }
        ),
        makeRequestWithRetry(
          `https://publicapi.myatrealty.com/api/v1/listings/${propertyID}/documents`,
          {
            headers: {
              Authorization: `Bearer ${bearerToken}`,
            },
          }
        ),
      ]);

      const propertyDetailsData =
        propertyDetailsResponse.data?.data?.attributes || {};
      const listingResponseData = listingResponse.data?.data?.attributes || {};
      const advertisementResponseData =
        advertisementResponse.data?.data?.[0]?.attributes || {};
      const locationResponseData =
        locationResponse.data?.data?.attributes || {};
      const featuresResponseData = featuresResponse.data?.data || [];
      const galleryResponseData = galleryResponse.data?.data || [];
      const documentsResponseData = documentsResponse.data?.data || [];
      const inspectionsResponseData = inspectionsResponse.data?.data || [];
      const saleType = listingResponseData.type;

      // Filter inspections based on today's date
      const today = new Date().toISOString().split("T")[0];
      const filteredInspections = inspectionsResponseData.filter(
        (inspection) => inspection.attributes.date >= today
      );

      const details = {
        saleType: saleType,
        ...propertyDetailsData,
        ...listingResponseData,
        ...advertisementResponseData,
        ...locationResponseData,
        features: featuresResponseData.map(
          (feature) => feature.attributes.feature
        ),
        inspections: filteredInspections.map((inspection) => ({
          date: inspection.attributes.date,
          startTime: inspection.attributes.startTime,
          endTime: inspection.attributes.endTime,
          type: inspection.attributes.type,
        })),
        imageUrls: galleryResponseData.map(
          (image) => image.meta.thumbnails.large
        ),
        documents: documentsResponseData.map((document) => ({
          url: document.attributes.url,
        })),
      };

      if (details.imageUrls.length > 0) {
        await createPostInWordPress(details);
      } else {
        console.log(`Skipping property ID ${propertyID} due to no images.`);
      }
    } catch (error) {
      console.error("Error fetching property or listing details:", error);
    }
  }
}
// Function to delete all posts in WordPress
async function deleteAllPosts() {
  try {
    const response = await axios.get(`${apiBaseUrl}?per_page=100`, {
      headers: {
        Authorization: `Basic ${token}`,
      },
    });

    const posts = response.data;

    for (const post of posts) {
      try {
        await axios.delete(`${apiBaseUrl}/${post.id}?force=true`, {
          headers: {
            Authorization: `Basic ${token}`,
          },
        });

        console.log(`Post with ID ${post.id} deleted successfully.`);
      } catch (error) {
        console.error(`Error deleting post with ID ${post.id}:`, error);
      }
    }
  } catch (error) {
    console.error("Error fetching posts for deletion:", error);
  }
}

// Function to build the content for the WordPress post
function buildPostContent(details) {
  const featuresList = details.features
    .map((feature) => `<li>${feature}</li>`)
    .join("");
  const imgUrls = details.imageUrls.join(",");
  const documentsList = details.documents.map((doc) => `${doc.url}`);
  const inspectionsList = details.inspections
    .map(
      (inspection) => `
    <li>
      Date: ${inspection.date}, Start Time: ${inspection.startTime}, End Time: ${inspection.endTime}, Type: ${inspection.type}
    </li>`
    )
    .join("");

  // Conditional rendering for additional details
  let additionalDetails = "";

  if (details.ensuites && details.ensuites !== 0) {
    additionalDetails += `<br>Ensuites: ${details.ensuites}`;
  }
  if (details.floorArea && details.floorArea !== 0 && details.floorAreaUnit) {
    additionalDetails += `<br>Floor Area: ${details.floorArea} ${details.floorAreaUnit}`;
  }
  if (details.garages && details.garages !== 0) {
    additionalDetails += `<br>Garages: ${details.garages}`;
  }
  if (details.landArea && details.landArea !== 0 && details.landAreaUnit) {
    additionalDetails += `<br>Land Area: ${details.landArea} ${details.landAreaUnit}`;
  }
  if (details.type) {
    additionalDetails += `<br>Property Type: ${details.type}`;
  }

  return `<div class="slider-cont">[custom_image_slider urls="${imgUrls}"]</div><div class="single-page">
  
  <div class="content-wrap">
    <div class="address-div">
      ${details.fullAddress}
    </div>
    <br>
    <div class="price-div">
      <h4>Price: ${details.displayPrice}</h4>
      <div class="amen-div">
        <div class="single-icon-wrap">
          <img src="https://realaliance.crystaldhub.com.au/wp-content/uploads/2024/06/1021592-200.png">
          ${details.bedrooms}
        </div>
        <div class="vertical-line"></div>
        <div class="single-icon-wrap">
          <img src="https://realaliance.crystaldhub.com.au/wp-content/uploads/2024/06/bathroom.png">
          ${details.bathrooms}
        </div>
        <div class="vertical-line"></div>
        <br>
        <div class="single-icon-wrap">
          <img src="https://realaliance.crystaldhub.com.au/wp-content/uploads/2024/06/car.png">
          ${details.carports}
        </div>
      </div>
    </div>
    <br>
    <h1>${details.headline}</h1>
    <br>
    <p>
      ${details.description}
      <div class="horizontal-line"></div>
    </p>
    <div class="features-wrap">
      <h4>PROPERTY DETAILS</h4>
      ${additionalDetails}
      <br>
    </div>
    <div class="horizontal-line"></div>
    <div class="features-wrap">
      <h4>PROPERTY FEATURES</h4>
      <div class="features-col">
        ${featuresList}
      </div>
    </div>
    <br>
    <div class="horizontal-line"></div>
    <br>
    <div class="ins-item">
      <h4>INSPECTION TIMES</h4>
      ${inspectionsList}
    </div>
    <br>
    <div class="doc-wrap">
      <br>
      [wpb-pcf-button]
    </div>
    <br>
    <div class="horizontal-line"></div>
    <br>
    <div class="doc-wrap">
      <h4>STATEMENT OF INFORMATION</h4>
      <a href="${documentsList}"><button>Download Document</button></a>
      <br>
    </div>
  </div>
  <div class="contact-blocks">
    <div class="top-block">
      <div class="contact-det">
        <img src="https://realaliance.crystaldhub.com.au/wp-content/uploads/2024/06/nandanan.png" alt="Nandana">
        <h4>Nandana Peiris</h4>
        <h6>Property Expert </h6>
        <div class="btn-wrap">
          <a href="tel:0452611234">
            <div class="btn-dial">
              <p>Call 0452611234</p>
            </div>
          </a>
        </div>
        <div class="btn-mail" href="">
          <a>
            <p>Email</p>
          </a>
        </div>
      </div>
    </div>
    <div class="bottom-block">
      <div class="contact-det">
        <img src="https://realaliance.crystaldhub.com.au/wp-content/uploads/2024/06/Chanaka-Perera.jpg" alt="Chanaka Perera ">
        <h4>Chanaka Perera </h4>
        <h6>Property Expert </h6>
        <div class="btn-wrap">
          <a href="tel:0422621234">
            <div class="btn-dial">
              <p>Call 0422621234</p>
            </div>
          </a>
        </div>
        <div class="btn-mail2" href="">
          <a>
            <p>Email</p>
          </a>
        </div>
      </div>
    </div>
    <div class="social-icons">
      <div class="icon-s">
        <a href=""><img src="https://realaliance.crystaldhub.com.au/wp-content/uploads/2024/06/pngwing.com1_.png"></a>
      </div>
      <div class="icon-s">
        <a href=""><img src="https://realaliance.crystaldhub.com.au/wp-content/uploads/2024/06/pngwing.com_.png"></a>
      </div>
      <div class="icon-s">
        <a href=""><img src="https://realaliance.crystaldhub.com.au/wp-content/uploads/2024/06/kisspng-scalable-vector-graphics-encapsulated-postscript-c-twitter-icon-free-icons-uihere-5cb81b1aa4b359.8343601915555694346746.png"></a>
      </div>
      <div class="icon-s">
        <a href=""><img src="https://realaliance.crystaldhub.com.au/wp-content/uploads/2024/06/computer-icons-linkedin-logo-linkedin-white-f64d35e9af265edf5af39fb44e00d2b7.png"></a>
      </div>
      <div class="icon-s">
        <a href=""><img src="https://realaliance.crystaldhub.com.au/wp-content/uploads/2024/06/kisspng-computer-icons-icon-design-5aff0274145661.6430053215266617480833.png"></a>
      </div>
    </div>
  </div>
</div></div>
  `;
}
// Function to create category if it doesn't exist and get its ID
async function getCategoryID(saleType) {
  try {
    // Check if category exists
    const response = await axios.get(
      `https://realaliance.crystaldhub.com.au/wp-json/wp/v2/categories?slug=${saleType}`,
      {
        headers: {
          Authorization: `Basic ${token}`,
        },
      }
    );

    // If category exists, return the ID
    if (response.data.length > 0) {
      return response.data[0].id;
    }

    // If category doesn't exist, create it
    const createCategoryResponse = await axios.post(
      `https://realaliance.crystaldhub.com.au/wp-json/wp/v2/categories`,
      {
        name: saleType,
        slug: saleType,
      },
      {
        headers: {
          Authorization: `Basic ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    return createCategoryResponse.data.id;
  } catch (error) {
    console.error("Error fetching or creating category:", error);
    throw error;
  }
}

// Function to create category if it doesn't exist and get its ID
async function getCategoryStatus(status) {
  try {
    // Check if category exists
    const response1 = await axios.get(
      `https://realaliance.crystaldhub.com.au/wp-json/wp/v2/categories?slug=${status}`,
      {
        headers: {
          Authorization: `Basic ${token}`,
        },
      }
    );

    // If category exists, return the ID
    if (response1.data.length > 0) {
      return response1.data[0].id;
    }

    // If category doesn't exist, create it
    const createCategoryResponse1 = await axios.post(
      `https://realaliance.crystaldhub.com.au/wp-json/wp/v2/categories`,
      {
        name: status,
        slug: status,
      },
      {
        headers: {
          Authorization: `Basic ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    return createCategoryResponse1.data.id;
  } catch (error) {
    console.error("Error fetching or creating category:", error);
    throw error;
  }
}

// Function to upload an image to the WordPress Media Library
async function uploadImage(imageUrl) {
  try {
    const response = await axios.get(imageUrl, {
      responseType: "arraybuffer",
    });

    const imageData = Buffer.from(response.data, "binary");

    const uploadResponse = await axios.post(
      `https://realaliance.crystaldhub.com.au/wp-json/wp/v2/media`,
      imageData,
      {
        headers: {
          Authorization: `Basic ${token}`,
          "Content-Type": response.headers["content-type"],
          "Content-Disposition": `attachment; filename=image.${
            response.headers["content-type"].split("/")[1]
          }`,
        },
      }
    );

    return uploadResponse.data.id;
  } catch (error) {
    console.error("Error uploading image:", error);
    throw error;
  }
}

// Function to create a post in WordPress
async function createPostInWordPress(details) {
  const postContent = buildPostContent(details);
  const categoryID = await getCategoryID(details.saleType);
  const categoryStatus = await getCategoryStatus(details.status);
  const featuredImage =
    details.imgUrls && details.imgUrls.length > 0 ? details.imgUrls[0] : "";
  const featuredImageUrl =
    details.imageUrls && details.imageUrls.length > 0
      ? details.imageUrls[0]
      : "";

  let featuredImageID = null;
  if (featuredImageUrl) {
    featuredImageID = await uploadImage(featuredImageUrl);
  }

  const postData = {
    title: `${details.fullAddress} ${details.status}`,
    content: postContent,
    status: "publish",
    featured_media: featuredImageID,
    categories: [categoryID, categoryStatus],
    acf: {
      img_url_tag: featuredImage,
      property_id: details.id,
      category: details.type,
      carports: `${details.carports}`,
      bedrooms: `${details.bedrooms}`,
      bathrooms: `${details.bathrooms}`,
      displayprice: `${details.displayPrice}`,
      streetname: `${details.streetName}`,
      suburb: `${details.suburb}`,
      status: `${details.status}`,
      saletype: `${details.saleType}`,
    },
  };

  try {
    const response = await axios.post(apiBaseUrl, postData, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Basic ${token}`,
      },
    });
    console.log("Post created successfully:");
  } catch (error) {
    if (error.response) {
      console.log("Error response:", error.response.data);
      console.log("Status:", error.response.status);
      console.log("Headers:", error.response.headers);
    } else if (error.request) {
      console.log("Error request:", error.request);
    } else {
      console.log("Error message:", error.message);
    }
    console.log("Config:", error.config);
  }
}

// Main function to handle the entire process
async function handlePropertyListings() {
  await deleteAllPosts();
  await fetchPropertyListings();
}

// Initial run
handlePropertyListings();
