/**
 * Altex Marketplace API Bridge
 * 
 * Swagger: https://marketplace.altex.ro/api_doc
 * 
 * Web admin stage: https://mkp-stage.altex.ro/admin
 * 
 */

const process = require('process')
const argv = require('minimist')(process.argv.slice(2))
const axios = require('axios')
const xml2js = require('xml2js')
const fs = require('fs')
const path = require('path')
const { Parser } = require('json2csv')
const CryptoJS = require('crypto-js')

const today = new Date().toISOString().split('T')[0];

const config = {

  // stage
  root: argv.apiroot || 'https://mkp-stage.altex.ro',
  publicKey: argv.pubkey || 'cabdd74122382757e92466e746c4c8d5',
  privateKey: argv.privkey || 'cd7d193768936e10a137e1e5d687c761',
  // prod
  // root: argv.apiroot || 'https://marketplace.altex.ro',
  // publicKey: argv.pubkey || '3d32d6920bf4ac948025551e8d07ecf6',
  // privateKey: argv.privkey || '56a83ac84476f0f475bcf072e11f6c2a',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Request-Public-Key': argv.pubkey || 'cabdd74122382757e92466e746c4c8d5',
  },
  itemsPerPage: 100,
  timeout: 3 * 60 * 1000, // 5 minutes
  sleep: 4, // seconds
  save_json: false,
  save_xml: false,
  save_csv: true,
  save_curl: false,
  log_file: 'altex-bridge.log',
  start_date: argv.startdate || dateSub(today, 30), // default start date is 30 days ago
  end_date: argv.enddate || today,
  shipping_location_id: 1, // default shipping location id
  courier_id: 7, // Cargus
  sender_name: 'MERT SA', // default sender name for AWB generation
  sender_contact_person: 'Test Contact Person', // default sender contact person for AWB generation
  sender_phone: '0770123456', // default sender phone for AWB generation
  sender_address: 'Strada Test, Nr. 1', // default sender address for AWB generation
  sender_county: 'Ilfov', // default sender county for AWB generation
  sender_city: 'Afumati', // default sender city for AWB generation
  sender_postalcode: '077020', // default sender postal code for AWB generation
  model_fields: {
    // 'base-products': ["id", "name", "measureunit_code", "taxgroup_vat_rate", "label", "stock_alerts"],
  }
}

let logStream = null
function log(...args) {
  if (!logStream) logStream = fs.createWriteStream(config.log_file)
  const tzOffset = new Date().getTimezoneOffset()
  const timestamp = new Date(Date.now() - tzOffset * 60 * 1000).toISOString().replace('T', ' ').replace('Z', '')
  const logMessage = `[${timestamp}] ${args.join(' ')}\n`
  logStream.write(logMessage)
  console.log(logMessage.trim())
}

// log('argv', argv)
if (argv.length === 0 || argv.help || argv.h) {
  // eslint-disable-next-line max-len
  log('Usage: altex-bridge.exe'
    + ' --pubkey=[yuorPublicKey]'
    + ' --privkey=[yourAPIKey]'
    + ' --startdate=[' + config.start_date + ']'
    + ' --enddate=[' + config.end_date + ']'
    + ' --cmd=[command]'
    + ' --params=[params]'
  )
}

/**
 * Generates a check digit from a partial EAN13.
 * 
 * https://www.gs1.org/services/how-calculate-check-digit-manually
 * 
 * @param {string} barcode - 12 digit EAN13 barcode without the check digit
 */
function checkDigitEAN13(barcode) {
  const sum = barcode.split('')
    .map((n, i) => n * (i % 2 ? 3 : 1)) // alternate between multiplying with 3 and 1
    .reduce((sum, n) => sum + n, 0) // sum all values

  const roundedUp = Math.ceil(sum / 10) * 10; // round sum to nearest 10

  const checkDigit = roundedUp - sum; // subtract round to sum = check digit

  return checkDigit;
}

function encodeRFC3986URI(str) {
  return encodeURIComponent(str)
    .replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
}

function serializeObjectToQueryString(params, prefix = '', join = '&') {
  const query = Object.keys(params)
    .map(key => {
      const value = params[key];

      if ((value !== null) && (typeof value === 'object')) {
        return serializeObjectToQueryString(value, (prefix ? `${prefix}%5B${encodeRFC3986URI(key)}%5D` : (encodeRFC3986URI(key))), join);
      } else if (value !== null) {
        return prefix ? `${prefix}%5B${encodeRFC3986URI(key)}%5D=${encodeRFC3986URI(value)}` : `${encodeRFC3986URI(key)}=${encodeRFC3986URI(value)}`;
      } else {
        return null;
      }
    })
    .filter(item => null !== item);

  return [].concat.apply([], query).join(join);
}

function getSignature(requestMethod, params, bodyMode) {
  const publicKey = config.publicKey;
  const privateKey = config.privateKey;
  //const dtString = Math.floor(Date.now() / 1000).toString().substring(0, 4);
  const currentDate = new Date();
  const dtString = currentDate.getDate().toString().padStart(2, '0') + (currentDate.getMonth() + 1).toString().padStart(2, '0');

  let paramsString = '';
  if ('GET' === requestMethod || 'DELETE' === requestMethod) {
    paramsString = serializeObjectToQueryString(params, '', '|');
  } else {
    let requestParams;
    requestParams = { ...params || {} };
    if (bodyMode === 'formdata') {
      delete requestParams['media'];
    } else {
      requestParams = JSON.parse(JSON.stringify(params) || {});
      //workaround for JSON keys rearrangement 
      // pm.request.body.raw = JSON.stringify(requestParams, null, 2);
    }

    paramsString = serializeObjectToQueryString(requestParams, '', '|');
  }

  const signaturePrivateKey = CryptoJS.SHA512(privateKey).toString(CryptoJS.digest);
  const signature = dtString + '' + CryptoJS.SHA512(`${publicKey}||${signaturePrivateKey}||${paramsString}||${dtString}`).toString(CryptoJS.digest).toLowerCase();
  // log({ publicKey, signaturePrivateKey, paramsString, dtString, signature, requestMethod });
  return signature;
}

function getFullUrl(url, params) {
  // build final url
  let fullUrl = ''
  const strParams = serializeObjectToQueryString(params)
  if (strParams) {
    fullUrl = `${config.root}${url}?${serializeObjectToQueryString(params)}`
  } else {
    fullUrl = `${config.root}${url}`
  }
  return fullUrl
}

async function sleep(seconds) {
  return new Promise(resolve => {
    log(`Sleeping for ${seconds} seconds...`)
    setTimeout(() => resolve(), seconds * 1000)
  })
}

// replace accented characters with non-accented ones
const strCleanup = str => str
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/\n/g, ' ')
  .replace(/"/g, '')
  .replace(/`/g, '')
  .replace(/,,/g, ',')
  .replace(/ ,/g, ',');

function dateSub(date, days) {
  const newDate = new Date(date);
  newDate.setDate(newDate.getDate() - days);
  return newDate.toISOString().split('T')[0];
}

const endpoints = {
  get: async (url, params, customName) => {
    let data = {}
    try {
      // API get
      params = {
        ...params
      }

      const options = {
        headers: {
          ...config.headers,
          'X-Request-Signature': getSignature('GET', params, 'query')
        },
        timeout: config.timeout
      }

      // build final url
      let fullUrl = getFullUrl(url, params)

      if (config.save_curl) {
        // save curl command
        let curlString = `curl -X GET "${fullUrl}"` // params are in the path
        for (const key in options.headers) {
          curlString += ` -H "${key}: ${options.headers[key]}"`
        }
        const name = customName + '.cmd'
        fs.writeFileSync(name, curlString)
      }

      const response = await axios.get(`${fullUrl}`, options)
      data = response.data.data || {}
      if (data.items) data =  data.items

    } catch (error) {
      log('Error in GET request:', error.message)
    }
    return data
  },
  getAll: async (url, params, customName) => {
    const items = []
    try {
      // API get
      params = {
        items_per_page: config.itemsPerPage,
        page_nr: 1,
        ...params
      }

      const options = {
        headers: {
          ...config.headers,
          'X-Request-Signature': getSignature('GET', params, 'query')
        },
        timeout: config.timeout
      }

      // build final url
      let fullUrl = getFullUrl(url, params)

      if (config.save_curl) {
        // save curl command
        let curlString = `curl -X GET "${fullUrl}"` // params are in the path
        for (const key in options.headers) {
          curlString += ` -H "${key}: ${options.headers[key]}"`
        }
        const name = customName + '.cmd'
        fs.writeFileSync(name, curlString)
      }

      let totalItems = null
      while (totalItems === null || totalItems > items.length) {
        // get the response
        log(`GET ${fullUrl}`)
        let retries = 3
        let response = null
        while (retries > 0) {
          try {
            response = await axios.get(`${fullUrl}`, options)
            break; // exit the retry loop if successful
          } catch (error) {
            log(`Error fetching ${fullUrl}: ${error.message}. Retrying... (${3 - retries + 1})`)
            retries--;
            if (retries === 0) {
              log('Max retries reached. Exiting...')
              throw error; // rethrow the error after max retries
            }
            // wait before retrying
            await sleep(config.sleep);
          }
        }
        // check if we have data
        if (!response.data || !response.data.data || !response.data.data.items) {
          log(`No data found for ${fullUrl}`)
          break; // exit the loop if no data is found
        }
        // push data
        items.push(...response.data.data.items)
        totalItems = parseInt(response.data.data.total_items) || 0
        // prepare for next page
        params.page_nr += 1
        fullUrl = getFullUrl(url, params)
        options.headers['X-Request-Signature'] = getSignature('GET', params, 'query')
      }

      log(`totalItems: ${totalItems}`)

    } catch (error) {
      log('Error in GET request:', error.message)
    }
    return items
  },
  post: async (url, data, customName) => {
    // API post
    // log(`POST ${url}`)
    const bodyMode = (data.media ? 'formdata' : 'query')
    const options = {
      headers: {
        ...config.headers,
        'X-Request-Signature': getSignature('POST', data, bodyMode) // no params for POST, so we use null
      },
      timeout: config.timeout
    }
    const fullUrl = `${config.root}${url}`

    if (bodyMode === 'formdata') options.headers['Content-Type'] = `multipart/form-data`

    if (config.save_curl) {
      // save curl command
      let curlString = `curl -X POST "${fullUrl}"` // params are in the path
      for (const key in options.headers) {
        curlString += ` -H "${key}: ${options.headers[key]}"`
      }
      const name = customName + '.cmd'
      fs.writeFileSync(name, curlString)
    }

    try {
      const response = await axios.post(fullUrl, data, options)
      return response
    } catch (error) {
      if (error.response) {
        log(`Error in POST request to ${fullUrl}`)
        log(`Headers: ${JSON.stringify(options)}`)
        log('Error data:', JSON.stringify(error.response.data))
      }
      log(error)
      return error.response.data
    }
  },
  put: async (url, data, customName) => {
    // API post
    const bodyMode = (data.media ? 'formdata' : 'query')
    // log(`PUT ${url}`)
    const options = {
      headers: {
        ...config.headers,
        'X-Request-Signature': getSignature('PUT', data, bodyMode) // no params for POST, so we use null
      },
      timeout: config.timeout
    }

    const fullUrl = `${config.root}${url}`

    if (bodyMode === 'formdata') options.headers['Content-Type'] = `multipart/form-data`

    if (config.save_curl) {
      // save curl command
      let curlString = `curl -X PUT "${fullUrl}"` // params are in the path
      for (const key in options.headers) {
        curlString += ` -H "${key}: ${options.headers[key]}"`
      }
      const name = customName + '.cmd'
      fs.writeFileSync(name, curlString)
    }

    try {
      const response = await axios.put(fullUrl, data, options)
      return response
    } catch (error) {
      if (error.response) {
        log(`Error in PUT request to ${fullUrl}`)
        log(`Headers: ${JSON.stringify(options)}`)
        log('Error data:', JSON.stringify(error.response.data))
      }
      log(error)
      return error.response.data
    }
  },
  delete: async (url, params, customName) => {
    let data = {}
    try {
      // API get
      params = {
        ...params
      }

      const options = {
        headers: {
          ...config.headers,
          'X-Request-Signature': getSignature('DELETE', params, 'query')
        },
        timeout: config.timeout
      }

      // build final url
      let fullUrl = getFullUrl(url, params)

      if (config.save_curl) {
        // save curl command
        let curlString = `curl -X DELETE "${fullUrl}"` // params are in the path
        for (const key in options.headers) {
          curlString += ` -H "${key}: ${options.headers[key]}"`
        }
        const name = customName + '.cmd'
        fs.writeFileSync(name, curlString)
      }

      const response = await axios.delete(`${fullUrl}`, options)
      data = response.data.data || {}

    } catch (error) {
      log('Error in DELETE request:', error.message)
    }
    return data
  },
  write: (data, fname) => {
    try {
      if (fs.existsSync(fname)) fs.unlinkSync(fname)
      fs.writeFileSync(fname, data)
      log(`Saved: ${fname}`)
    } catch (error) {
      log(error)
    }
  },
  save: (data, fname) => {
    if (config.save_json) {
      endpoints.write(JSON.stringify(data), `${fname}.json`)
    }
    if (config.save_xml) {
      const xmlBuilder = new xml2js.Builder({ rootName: fname })
      endpoints.write(xmlBuilder.buildObject({ rows: data }), `${fname}.xml`)
    }
    if (config.save_csv) {
      const parserOpts = {}
      // if we want a specific structure
      if (config.model_fields[fname]) parserOpts.fields = config.model_fields[fname]
      const parser = new Parser(parserOpts)
      let csv = ''
      try {
        csv = parser.parse(data)
      } catch (error) {
        // caught
      }
      endpoints.write(csv, `${fname}.csv`)
    }
  },
  deleteFile: (fname) => {
    try {
      const jsonName = `${fname}.json`
      if (fs.existsSync(jsonName)) fs.unlinkSync(jsonName)
      const xmlName = `${fname}.xml`
      if (fs.existsSync(xmlName)) fs.unlinkSync(xmlName)
      const csvName = `${fname}.csv`
      if (fs.existsSync(csvName)) fs.unlinkSync(csvName)

      log(`Deleted: ${fname}`)
    } catch (error) {
      log(error)
    }
  },
  getOrderDetails: async (orderId) => {
    const baseName = `order_${orderId}`
    endpoints.deleteFile(baseName)
    const orderDetail = await endpoints.get(`/v2.0/sales/order/${orderId}/`, {}, baseName)
    endpoints.save(orderDetail, baseName)
    return orderDetail
  },
  exportOrders: async (status) => {
    const baseNameSint = 'orders_sint'
    const baseNameDet = 'orders_det'
    const baseNameAwb = 'orders_awb'
    const baseNameInvoice = 'orders_invoices'
    endpoints.deleteFile(baseNameSint)
    endpoints.deleteFile(baseNameDet)
    endpoints.deleteFile(baseNameAwb)
    endpoints.deleteFile(baseNameInvoice)

    const ordersFilter = {}
    ordersFilter.start_date = config.start_date
    ordersFilter.end_date = config.end_date
    if (status) ordersFilter.status = status
    // Id	Status
    // 1	Registered
    // 2	In Progress
    // 3	Partial Shipped
    // 4	Shipped
    // 5	Partial Returned
    // 6	Returned
    // 7	Cancelled
    // 8	Ready to be shipped
    // 9	Completed
    // 10	Technical cancelling

    const aOrders = await endpoints.getAll('/v2.0/sales/order/', ordersFilter, baseNameSint)

    let aSintRows = []
    let aDetRows = []
    let aAwbRows = []
    let aInvoiceRows = []
    for (const order of aOrders) {
      const orderId = order.order_id
      const orderDetail = await endpoints.get(`/v2.0/sales/order/${orderId}/`, {}, baseNameDet)
      // log(orderDetail)

      // extract products
      const products = (orderDetail.products || []).map(product => { return { ...product, order_id: orderId } })
      aDetRows.push(...products)
      // remove products from orderDetail
      delete orderDetail.products

      // extract awbs
      const awbs = (orderDetail.awbs || []).map(awb => { return { ...awb, order_id: orderId } })
      aAwbRows.push(...awbs)
      // remove awbs from orderDetail
      delete orderDetail.awbs

      // extract invoices
      const invoices = (orderDetail.invoices || []).map(invoice => { return { ...invoice, order_id: orderId } })
      aInvoiceRows.push(...invoices)
      // remove invoices from orderDetail
      delete orderDetail.invoices

      // cleanup strings
      orderDetail.billing_customer_name = strCleanup(orderDetail.billing_customer_name)
      orderDetail.shipping_customer_name = strCleanup(orderDetail.shipping_customer_name)
      orderDetail.billing_address = strCleanup(orderDetail.billing_address)
      orderDetail.shipping_address = strCleanup(orderDetail.shipping_address)
      orderDetail.billing_city = strCleanup(orderDetail.billing_city)
      orderDetail.shipping_city = strCleanup(orderDetail.shipping_city)

      // add order to sint rows
      aSintRows.push(orderDetail)
    }
    endpoints.save(aSintRows, baseNameSint)
    endpoints.save(aDetRows, baseNameDet)
    endpoints.save(aAwbRows, baseNameAwb)
    endpoints.save(aInvoiceRows, baseNameInvoice)

  },
  updateOrderStatus: async (orderId, status) => {
    // update order status
    // Id	Status
    // 1	Registered
    // 2	In Progress
    // 3	Partial Shipped
    // 4	Shipped
    // 5	Partial Returned
    // 6	Returned
    // 7	Cancelled
    // 8	Ready to be shipped
    // 9	Completed
    // 10	Technical cancelling

    const res = await endpoints.put(`/v2.0/sales/order/${orderId}/`, {status: status})
    if (res.data && res.data.message) {
      log(`Message: ${res.data.message}`)
    }
    return res
  },
  addOrderInvoice: async (orderId, invoiceNumber, invoicePath) => {
    // get order details
    const orderDetail = await endpoints.getOrderDetails(orderId)
    const products = (orderDetail.products || []).map(product => product.id)
    // add invoice to order
    const invoiceData = {
      'media': fs.createReadStream(invoicePath), // invoice PDF file
      'name': path.basename(invoicePath), // name of the invoice file
      'products': products,
      'invoice_number': invoiceNumber,
    }

    const res = await endpoints.post(`/v2.0/sales/order/${orderId}/invoice/`, invoiceData, 'invoice')
    if (res.data && res.data.message) {
      log(`Message: ${res.data.message}`)
    }
    return res
  },
  deleteOrderInvoice: async (orderId) => {
    // delete order invoice
    const res = await endpoints.delete(`/v2.0/sales/order/${orderId}/invoice/`, {}, 'invoice')
    if (res.data && res.data.message) {
      log(`Message: ${res.data.message}`)
    }
    return res
  },
  generateOrderAWB: async (orderId) => {
    const shippingLocations = await endpoints.get('/v2.0/sales/location/', {}, 'shipping_locations')
    const orderDetails = await endpoints.getOrderDetails(orderId)
    const awbData = {
      courier_id: config.courier_id,
      location_id: (shippingLocations.length > 0 ? shippingLocations[0].courier_location_id : config.shipping_location_id),
      destination_city: orderDetails.shipping_city,
      sender_name: config.sender_name,
      sender_contact_person: config.sender_contact_person,
      sender_phone: config.sender_phone,
      sender_address: config.sender_address,
      sender_county: config.sender_county,
      sender_city: config.sender_city,
      sender_postalcode: config.sender_postalcode,
      destination_contact_person: orderDetails.shipping_customer_name,
      destination_phone: orderDetails.shipping_phone_number,
      destination_address: orderDetails.shipping_address,
      destination_county: orderDetails.shipping_region,
      destination_postalcode: '',
      order_packages: 1, // default to 1 package
      order_weight: [2], // default to 2 kg
      order_height: [20], // default to 20 cm
      order_length: [20], // default to 20 cm
      order_size: [1], // one package
      declared_value: orderDetails.total_price, // default to total price
      order_awb_format: '0'
    }

    const res = await endpoints.post(`/v2.0/sales/order/${orderId}/awb/generate`, awbData, 'awb')
    log('Response for generateOrderAWB:', JSON.stringify(res.message), JSON.stringify(res.data))
  },
  getRMADetails: async (rmaId) => {
    const baseName = `rma_${rmaId}`
    endpoints.deleteFile(baseName)
    const res = await endpoints.get(`/v2.0/sales/rma/${rmaId}/`, {}, baseName)
    endpoints.save(res, baseName)
    return res
  },
  exportRMAs: async (status) => {
    const baseNameSint = 'rmas_sint'
    const baseNameDet = 'rmas_det'
    endpoints.deleteFile(baseNameSint)
    endpoints.deleteFile(baseNameDet)

    const rmasFilter = {}
    rmasFilter.created_at = config.start_date
    if (status) rmasFilter.status = status
    // Id	Status
    // 1	Registered
    // 2	In Progress
    // 3	Received
    // 4	Resolved
    // 5	Cancelled
    // 6	Visualized

    const aRMAs = await endpoints.getAll('/v2.0/sales/rma/', rmasFilter, baseNameSint)

    let aSintRows = []
    let aDetRows = []
    for (const rma of aRMAs) {
      const rmaId = rma.rma_id
      const rmaDetail = await endpoints.get(`/v2.0/sales/rma/${rmaId}/`, {}, baseNameDet)
      // log(rmaDetail)

      // extract products
      const products = (rmaDetail.products || []).map(product => { return { ...product, rma_id: rmaId } })
      aDetRows.push(...products)
      // remove products from rmaDetail
      delete rmaDetail.products

      // add rma to sint rows
      aSintRows.push(rmaDetail)
    }
    endpoints.save(aSintRows, baseNameSint)
    endpoints.save(aDetRows, baseNameDet)

  },
  exportCouriers: async () => {
    // delete previous data
    const baseName = 'couriers'
    endpoints.deleteFile(baseName)

    const aRows = await endpoints.getAll('/v2.0/sales/courier/', {}, baseName)

    endpoints.save(aRows, baseName)
  },
  exportLocations: async () => {
    // delete previous data
    const baseName = 'locations'
    endpoints.deleteFile(baseName)

    const aRows = await endpoints.getAll('/v2.0/sales/location/', {}, baseName)

    endpoints.save(aRows, baseName)
  },
  exportCategories: async () => {
    // delete previous data
    const baseName = 'categories'
    endpoints.deleteFile(baseName)

    const aRows = await endpoints.getAll('/v2.0/catalog/category/', { allowed: true }, baseName)

    endpoints.save(aRows, baseName)
  },
  exportAttributes: async () => {
    // delete previous data
    let baseName = 'sets'
    endpoints.deleteFile(baseName)

    let aRows = await endpoints.getAll('/v2.0/catalog/sets/', {}, baseName)

    endpoints.save(aRows, baseName)

    // filter sets to a specific list
    aRows = aRows.filter(set => set.id === 331 || set.id === 669 || set.id === 585)

    // get attributes for each set
    baseName = 'attributes'
    const aAttributes = []
    for (const set of aRows) {
      const setId = set.id
      const attrs = await endpoints.getAll(`/v2.0/catalog/sets/${setId}/attributes`, {}, baseName)
      // extract only relevant data
      aAttributes.push(...attrs.map(attr => { return { set_id: setId, code: attr.code, name: attr.name } }))
    }
    endpoints.save(aAttributes, baseName)
  },
  getProductDetails: async (productId) => {
    const baseName = `product_${productId}`
    endpoints.deleteFile(baseName)
    const res = await endpoints.get(`/v2.0/catalog/product/${productId}/`, {}, baseName)
    endpoints.save(res, baseName)
    return res
  },
  exportProducts: async () => {
    // delete previous data
    const baseName = 'products'
    endpoints.deleteFile(baseName)

    let aRows = await endpoints.getAll('/v2.0/catalog/product/', {}, baseName)
    aRows = aRows.map(product => {
      // cleanup strings
      product.name = strCleanup(product.name)
      product.description = strCleanup(product.description)
      product.brand = strCleanup(product.brand)
      product.ean = (Array.isArray(product.ean) ? product.ean.join(', ') : product.ean)
      return product
    })

    endpoints.save(aRows, baseName)
  },
  exportOffers: async () => {
    // delete previous data
    const baseName = 'offers'
    endpoints.deleteFile(baseName)

    const aRows = await endpoints.getAll('/v2.0/catalog/offer/', {}, baseName)

    endpoints.save(aRows, baseName)
  },
  testAddProduct: async () => {
    let res = null;
    let product = null;
    let barcode = null;

    product = JSON.parse(fs.readFileSync('./data/test-product1.json', 'utf8'))
    // generate a new barcode
    // EAN13 barcode is 12 digits + 1 check digit
    barcode = new Date().getTime().toString().substring(1, 13)
    barcode = barcode + checkDigitEAN13(barcode)
    product['0'].ean = barcode
    product['0'].offer.seller_product_code = barcode
    res = await endpoints.post('/v2.0/catalog/product/', product, 'product')
    log('Response for test product 1:', JSON.stringify(res.message), JSON.stringify(res.data))

    product = JSON.parse(fs.readFileSync('./data/test-product2.json', 'utf8'))
    // generate a new barcode
    // EAN13 barcode is 12 digits + 1 check digit
    barcode = new Date().getTime().toString().substring(1, 13)
    barcode = barcode + checkDigitEAN13(barcode)
    product['0'].ean = barcode
    product['0'].offer.seller_product_code = barcode
    res = await endpoints.post('/v2.0/catalog/product/', product, 'product')
    log('Response for test product 1:', JSON.stringify(res.message), JSON.stringify(res.data))
  },
  testUpdateProduct: async () => {
    let res = null;
    let product = null;
    let id = null;

    id = '684733f4907cd317215175f4' // test product 1
    product = await endpoints.get(`/v2.0/catalog/product/${id}/`, {}, 'product')
    // change the description
    product.description += '\n' + new Date().getTime()
    product.attributes.price_unit = 'Pret/Bucata' // don't know the correct value

    res = await endpoints.put(`/v2.0/catalog/product/${id}/`, { description: product.description, attributes: product.attributes }, 'product')
    log('Response for test product 1 update:', JSON.stringify(res.message), JSON.stringify(res.data))

  },
  testAddOffer: async () => {

    const offer = {
      '0': {
        'product_id': '684733f4907cd317215175f4', // test product 1
        'stock': 123
      }
    }

    const res = await endpoints.post(`/v2.0/catalog/offer/`, offer, 'offer')
    log('Response for test offer add:', JSON.stringify(res.message), JSON.stringify(res.data))
  },
  testUpdateOffer: async () => {

    const offer = {
      '0': {
        'offer_id': '479968', // test product 1
        'stock': 123
      }
    }

    const res = await endpoints.put(`/v2.0/catalog/offer/`, offer, 'offer')
    log('Response for test offer add:', JSON.stringify(res.message), JSON.stringify(res.data))
  },
  testUpdateStock: async () => {

    const stock = {
      '0': {
        'offer_id': '479968', // test product 1
        'stock': 123
      }
    }

    const res = await endpoints.put(`/v2.0/catalog/stock/`, stock, 'stock')
    log('Response for test stock update:', JSON.stringify(res.message), JSON.stringify(res.data))
  },
  testUpdateOrder: async () => {
    const res = await endpoints.updateOrderStatus(94140, 2) // order 94140, status 2
    log('Response for test order update:', JSON.stringify(res.message), JSON.stringify(res.data))
  },
  testGenerateAWB: async () => {
    await endpoints.generateOrderAWB(94140)
  },
  testAddInvoice: async () => {
    const res = await endpoints.addOrderInvoice(94140, 'MERT107659', './data/test-invoice.pdf')
    log('Response for test invoice add:', JSON.stringify(res.message), JSON.stringify(res.data))
  },
  testDeleteInvoice: async () => {
    const res = await endpoints.deleteOrderInvoice(94140)
    log('Response for test invoice delete:', JSON.stringify(res.message), JSON.stringify(res.data))
  },
  testAddRMAInvoice: async () => {
    const rmaId = 2764
    const rmaData = {
      'media': fs.createReadStream('./data/test-invoice.pdf'), // invoice PDF file
      'name': 'test-invoice.pdf', // name of the invoice file
      'products': ['2777'],
      'invoice_number': 'MERT107659',
    }

    const res = await endpoints.post(`/v2.0/sales/rma/${rmaId}/invoice/`, rmaData, 'rma')
    log('Response for test RMA invoice add:', JSON.stringify(res.message), JSON.stringify(res.data))
  },
  testDeleteRMAInvoice: async () => {
    const rmaId = 2764

    const res = await endpoints.delete(`/v2.0/sales/rma/${rmaId}/invoice/`, {}, 'rma')
    log('Response for test RMA invoice delete:', JSON.stringify(res.message), JSON.stringify(res.data))
  },
  testGenerateRMAawb: async () => {
    const rmaId = 2764
    const courierId = 7 // Cargus

    const rmaDetails = await endpoints.getRMADetails(rmaId)
    const orderDetails = await endpoints.getOrderDetails(rmaDetails.order_id)

    const awbData = {
      courier_id: courierId,
      destination_city: config.sender_city,
      sender_name: orderDetails.shipping_customer_name,
      seller_name: config.sender_name,
      tertiary_client_id: 1005962049, // default tertiary client id - hardcoded
      order_envelopes: 0,
      order_shipping_payment: 0,
      pickup_start_date: new Date().toISOString(), // current date
      pickup_end_date: new Date(new Date().setDate(new Date().getDate() + 2)).toISOString(), // over next day
      price_table_id: '',
      sender_contact_person: config.sender_contact_person,
      destination_return_address: orderDetails.shipping_address,
      sender_phone: orderDetails.shipping_phone_number,
      sender_address: orderDetails.shipping_address,
      sender_county: orderDetails.shipping_region,
      sender_city: orderDetails.shipping_city,
      sender_postalcode: '',
      destination_contact_person: config.sender_contact_person,
      destination_phone: config.sender_phone,
      destination_address: config.sender_address,
      destination_county: config.sender_county,
      destination_postalcode: config.sender_postalcode,
      order_packages: 1,
      order_weight: 2,
      order_height: 2,
      order_length: 2,
      order_size: 1,
      declared_value: orderDetails.total_price, // default to total price
      order_awb_format: '0',
    }

    const res = await endpoints.post(`/v2.0/sales/rma/${rmaId}/awb/generate`, awbData, 'awb')
    log('Response for test RMA AWB generate:', JSON.stringify(res.message), JSON.stringify(res.data))
  },
}

async function main() {
  try {
    if (argv.cmd && typeof endpoints[argv.cmd] === 'function') {
      // run a specific command
      log(`Running command: ${argv.cmd}`)
      
      if (argv.params) {
        // parse params from JSON string
        const params = JSON.parse(argv.params)
        if (Array.isArray(params)) {
          // if params is an array, spread it
          await endpoints[argv.cmd](...params)
        } else {
          // pass params
          await endpoints[argv.cmd](params)
        }
      } else {
        // run command without params
        await endpoints[argv.cmd]()
      }
      
      return
    }
    // default actions
    await endpoints.exportOrders() // do not filter by status
    await endpoints.exportProducts()

    // await endpoints.testUpdateOrder()
    // await endpoints.exportRMAs() // do not filter by status
    // await endpoints.exportCouriers()
    // await endpoints.exportLocations()
    // await endpoints.exportCategories()
    // await endpoints.exportAttributes()
    // await endpoints.testAddProduct()
    // await endpoints.testUpdateProduct()
    // await endpoints.testAddOffer()
    // await endpoints.testUpdateOffer()
    // await endpoints.exportOffers()
    // await endpoints.testUpdateStock()
    // await endpoints.testGenerateAWB()
    // await endpoints.testAddInvoice()
    // await endpoints.testDeleteInvoice()
    // await endpoints.testAddRMAInvoice()
    // await endpoints.testDeleteRMAInvoice()
    // await endpoints.testGenerateRMAawb()
  } catch (error) {
    console.error('Error in main function:', error.message)
  }
}

main().then(() => log('Import finished'))
