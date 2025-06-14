/**
 * Altex Marketplace API Bridge
 * 
 * Swagger: https://marketplace.altex.ro/api_doc
 */

const process = require('process')
const argv = require('minimist')(process.argv.slice(2))
const axios = require('axios')
const xml2js = require('xml2js')
const fs = require('fs')
const { Parser } = require('json2csv')
const CryptoJS = require('crypto-js')

const today = new Date().toISOString().split('T')[0];
const oneWeekAgo = new Date(new Date().setDate(new Date().getDate() - 7)).toISOString().split('T')[0];


const config = {

  root: 'https://mkp-stage.altex.ro', // 'https://mkp.altex.ro', // production
  publicKey: argv.pubkey || 'cabdd74122382757e92466e746c4c8d5',
  privateKey: argv.privkey || 'cd7d193768936e10a137e1e5d687c761',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Request-Public-Key': argv.pubkey || 'cabdd74122382757e92466e746c4c8d5',
  },
  itemsPerPage: 100,
  timeout: 3 * 60 * 1000, // 5 minutes
  sleep: 4, // seconds
  save_json: true,
  save_xml: false,
  save_csv: true,
  save_curl: true,
  date_start: argv.startdate || oneWeekAgo,
  date_end: argv.enddate || today,
  model_fields: {
    // 'base-products': ["id", "name", "measureunit_code", "taxgroup_vat_rate", "label", "stock_alerts"],
  }
}

// console.log('argv', argv)
if (!argv.key) {
  // eslint-disable-next-line max-len
  console.log('Usage: emag-bridge.exe'
    + ' --pubkey=[yuorPublicKey]'
    + ' --privkey=[yourAPIKey]'
    + ' --startdate=[' + config.date_start + ']'
    + ' --enddate=[' + config.date_end + ']')
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
  // console.log({ publicKey, signaturePrivateKey, paramsString, dtString, signature, requestMethod });
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

async function sleep (seconds) {
  return new Promise(resolve => {
    console.log(`Sleeping for ${seconds} seconds...`)
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

    } catch (error) {
      console.log('Error in GET request:', error.message)
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
        console.log(`GET ${fullUrl}`)
        let retries = 3
        let response = null
        while (retries > 0) {
          try {
            response = await axios.get(`${fullUrl}`, options)
            break; // exit the retry loop if successful
          } catch (error) {
            console.log(`Error fetching ${fullUrl}: ${error.message}. Retrying... (${3 - retries + 1})`)
            retries--;
            if (retries === 0) {
              console.log('Max retries reached. Exiting...')
              throw error; // rethrow the error after max retries
            }
            // wait before retrying
            await sleep(config.sleep);
          }
        }
        // check if we have data
        if (!response.data || !response.data.data || !response.data.data.items) {
          console.log(`No data found for ${fullUrl}`)
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

      console.log(`totalItems: ${totalItems}`)

    } catch (error) {
      console.log('Error in GET request:', error.message)
    }
    return items
  },
  post: async (url, data, customName) => {
    // API post
    // console.log(`POST ${url}`)
    const options = {
      headers: {
        ...config.headers,
        'X-Request-Signature': getSignature('POST', data, 'query') // no params for POST, so we use null
      },
      timeout: config.timeout
    }
    const fullUrl = `${config.root}${url}`
    try {
      const response = await axios.post(fullUrl, data, options)

      return response
    } catch (error) {
      if (error.response) {
        console.log(`Error in POST request to ${fullUrl}`)
        console.log(`Headers: ${JSON.stringify(options)}`)
        console.log('Error data:', JSON.stringify(error.response.data))
      }
      console.log(error)
      return error.response.data
    }
  },
  put: async (url, data, customName) => {
    // API post
    // console.log(`PUT ${url}`)
    const options = {
      headers: {
        ...config.headers,
        'X-Request-Signature': getSignature('PUT', data, 'query') // no params for POST, so we use null
      },
      timeout: config.timeout
    }
    const fullUrl = `${config.root}${url}`
    try {
      const response = await axios.put(fullUrl, data, options)

      return response
    } catch (error) {
      if (error.response) {
        console.log(`Error in PUT request to ${fullUrl}`)
        console.log(`Headers: ${JSON.stringify(options)}`)
        console.log('Error data:', JSON.stringify(error.response.data))
      }
      console.log(error)
      return error.response.data
    }
  },
  write: (data, fname) => {
    try {
      if (fs.existsSync(fname)) fs.unlinkSync(fname)
      fs.writeFileSync(fname, data)
      console.log(`Saved: ${fname}`)
    } catch (error) {
      console.log(error)
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
  delete: (fname) => {
    try {
      const jsonName = `${fname}.json`
      if (fs.existsSync(jsonName)) fs.unlinkSync(jsonName)
      const xmlName = `${fname}.xml`
      if (fs.existsSync(xmlName)) fs.unlinkSync(xmlName)
      const csvName = `${fname}.csv`
      if (fs.existsSync(csvName)) fs.unlinkSync(csvName)

      console.log(`Deleted: ${fname}`)
    } catch (error) {
      console.log(error)
    }
  },
  exportCustomerInvoices: async () => {
    // delete previous data
    endpoints.delete('invoices_sint')
    endpoints.delete('invoices_det')

    const aCustomerInvoices = await endpoints.post('/customer-invoice/read', { date_start: config.date_start, date_end: config.date_end }, 'invoices', 'customer-invoices')
    const aOrders = await endpoints.post('/order/read', { date_start: config.date_start, date_end: config.date_end }, null, 'orders')
    // process data
    const aSint = []
    const aDet = []
    for (const i of aCustomerInvoices) {
      if (config.save_json) {
        // save raw data
        endpoints.write(JSON.stringify(i), `invoice_${i.number}.json`)
      }

      // flatten sint (no lines)
      const sint = {
        category: i.category,
        order_id: i.order_id,
        number: i.number,
        date: i.date,
        is_storno: i.is_storno,
        supplier_name: strCleanup(i.supplier.name),
        supplier_register_number: i.supplier.register_number,
        supplier_cif: i.supplier.cif,
        supplier_tax_code: i.supplier.tax_code,
        supplier_social_capital: i.supplier.social_capital,
        supplier_iban: i.supplier.iban,
        supplier_bank: i.supplier.bank,
        supplier_country: i.supplier.country,
        supplier_address: strCleanup(i.supplier.address.replace(/\n/g, ' ')), // remove new lines
        customer_name: strCleanup(i.customer.name),
        customer_register_number: i.customer.register_number,
        customer_cif: i.customer.cif,
        customer_tax_code: i.customer.tax_code,
        customer_iban: i.customer.iban,
        customer_bank: i.customer.bank,
        customer_country: i.customer.country,
        customer_address: strCleanup(i.customer.address.replace(/\n/g, ' ')), // remove new lines
        total_without_vat: i.total_without_vat,
        total_vat_value: i.total_vat_value,
        total_with_vat: i.total_with_vat,
        currency: i.currency,
      }

      // find order
      const o = aOrders.find(o => o.id === i.order_id)
      if (o) {
        if (config.save_json) {
          // save raw data
          endpoints.write(JSON.stringify(i), `order_${o.id}.json`)
        }
        sint.order_type = o.type
        sint.order_date = o.date
        sint.order_payment_mode = o.payment_mode
        sint.order_detailed_payment_method = o.detailed_payment_method
        sint.order_delivery_mode = o.delivery_mode
        sint.order_observation = o.observation
        sint.order_status = o.status
        sint.order_payment_status = o.payment_status
        sint.customer_company = o.customer.company
        sint.customer_phone_1 = o.customer.phone_1
        sint.customer_id = o.customer.id
        sint.customer_is_vat_payer = o.customer.is_vat_payer
        sint.customer_legal_entity = o.customer.legal_entity
        sint.customer_billing_suburb = o.customer.billing_suburb
        sint.customer_billing_city = o.customer.billing_city
        sint.customer_billing_postal_code = o.customer.billing_postal_code
        sint.shipping_tax = o.shipping_tax
      } else {
        console.log(`Order ${i.order_id} not found for invoice ${i.number}`)
      }

      aSint.push(sint)

      for (const p of o.products) {
        const det = {
          invoice_number: i.number,
          ...p
        }
        aDet.push(det)
      }
    }
    endpoints.save(aSint, 'invoices_sint')
    endpoints.save(aDet, 'invoices_det')
  },
  exportCategories: async () => {
    // delete previous data
    const baseName = 'categories'
    endpoints.delete(baseName)

    const aRows = await endpoints.getAll('/v2.0/catalog/category/', { allowed: true}, baseName)

    endpoints.save(aRows, baseName)
  },
  exportAttributes: async () => {
    // delete previous data
    let baseName = 'sets'
    endpoints.delete(baseName)

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
  exportProducts: async () => {
    // delete previous data
    const baseName = 'products'
    endpoints.delete(baseName)

    const aRows = await endpoints.getAll('/v2.0/catalog/product/', {}, baseName)

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
    console.log('Response for test product 1:', JSON.stringify(res.message), JSON.stringify(res.data))

    product = JSON.parse(fs.readFileSync('./data/test-product2.json', 'utf8'))
    // generate a new barcode
    // EAN13 barcode is 12 digits + 1 check digit
    barcode = new Date().getTime().toString().substring(1, 13)
    barcode = barcode + checkDigitEAN13(barcode)
    product['0'].ean = barcode
    product['0'].offer.seller_product_code = barcode
    res = await endpoints.post('/v2.0/catalog/product/', product, 'product')
    console.log('Response for test product 1:', JSON.stringify(res.message), JSON.stringify(res.data))
  },
  testUpdateProduct: async () => {
    let res = null;
    let product = null;
    let barcode = null;
    let id = null;
    
    id = '684733f4907cd317215175f4' // test product 1
    product =await endpoints.get(`/v2.0/catalog/product/${id}/`, {}, 'product')
    product = JSON.parse(fs.readFileSync('./data/test-product1.json', 'utf8'))
    // generate a new barcode
    // EAN13 barcode is 12 digits + 1 check digit
    barcode = new Date().getTime().toString().substring(1, 13)
    barcode = barcode + checkDigitEAN13(barcode)
    product['0'].ean = barcode
    product['0'].offer.seller_product_code = barcode
    res = await endpoints.post('/v2.0/catalog/product/', product, 'product')
    console.log('Response for test product 1:', JSON.stringify(res.message), JSON.stringify(res.data))

    product = JSON.parse(fs.readFileSync('./data/test-product2.json', 'utf8'))
    // generate a new barcode
    // EAN13 barcode is 12 digits + 1 check digit
    barcode = new Date().getTime().toString().substring(1, 13)
    barcode = barcode + checkDigitEAN13(barcode)
    product['0'].ean = barcode
    product['0'].offer.seller_product_code = barcode
    res = await endpoints.post('/v2.0/catalog/product/', product, 'product')
    console.log('Response for test product 1:', JSON.stringify(res.message), JSON.stringify(res.data))
  }
}

async function main () {
  try {
    // await endpoints.exportCustomerInvoices()
    // await endpoints.exportCategories()
    // await endpoints.exportAttributes()
    // await endpoints.testAddProduct()
    await endpoints.testUpdateProduct()
    // await endpoints.exportProducts()
  } catch (error) {
    console.error('Error in main function:', error.message)
  }
}

main().then(() => console.log('Import finished'))
