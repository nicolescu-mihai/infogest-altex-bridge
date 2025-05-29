const process = require('process')
const argv = require('minimist')(process.argv.slice(2))
const axios = require('axios')
const xml2js = require('xml2js')
const fs = require('fs')
const { Parser } = require('json2csv')
const sleep = require('sleep')
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
            await new Promise(resolve => setTimeout(resolve, 2000)); // wait 2 seconds before retrying
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

  post: async (url, params, resultRowsKey, customName) => {
    // API post
    // console.log(`POST ${url}`)
    try {
      const aRows = []
      const rParams = { itemsPerPage: config.itemsPerPage, currentPage: 0, ...params }
      const options = {
        headers: config.auth_hrd,
        timeout: config.timeout
      }
      let response = null
      let totalResults = null

      while (aRows.length < totalResults || totalResults === null) {
        // next page is needed
        rParams.currentPage++
        // console.log(`GET page: ${rParams.currentPage}`)

        console.log(`Sleeping for ${config.sleep} seconds to avoid being blocked`)
        sleep.sleep(config.sleep)

        // call emag API
        response = await axios.post(`${config.root}${url}`, rParams, options)

        if (Array.isArray(response.data.results) && response.data.results.length > 0) {
          // there is no info on the total results, but we have some rows

          // extract rows
          aRows.push(...response.data.results)

          // try to get more
          totalResults = (response.data.results.length < rParams.itemsPerPage ? aRows.length : aRows.length + 1)
        } else {
          // we should have the total results info

          // extract total results
          if (response.data.results.total_results) {
            // we know how many results we have
            totalResults = response.data.results.total_results
          }

          // extract rows
          aRows.push(...response.data.results[resultRowsKey])
        }

        // log progress
        const r = response.request
        console.log(`${r.method} ${r.protocol}//${r.host}${r.path} ${aRows.length}/${totalResults} rows`)

        if (config.save_curl && rParams.currentPage === 1) {
          // save curl command
          const curl = `curl -X POST "${r.protocol}//${r.host}${r.path}"` // params are in the path
          const headers = `-H "Authorization: ${config.auth_hrd['Authorization']}"`
          const data = `-d '${JSON.stringify(rParams)}'`
          const name = (customName || url.match(/\/(?:.(?!\/))+$/)[0].replace('/', '')) + '.cmd'
          const cmd = `${curl}^\n ${headers}^\n ${data}`
          fs.writeFileSync(name, cmd)
        }
      }

      return aRows
    } catch (error) {
      if (error.response) {
        console.log('status', error.response.status)
        console.log('data', error.response.data)
        if ([401, 403].indexOf(error.response.status) > -1) {
          console.log('error', 'Wrong credentials, please check the user and password')
          throw new Error('Wrong credentials, please check the user and password')
        }
      } else {
        console.log(error)
      }
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

    const aRows = await endpoints.get('/v2.0/catalog/category/', {}, baseName)

    endpoints.save(aRows, baseName)
  },
  exportAttributes: async () => {
    // delete previous data
    let baseName = 'sets'
    endpoints.delete(baseName)

    let aRows = await endpoints.get('/v2.0/catalog/sets/', {}, baseName)

    endpoints.save(aRows, baseName)

    // filter sets to a specific list
    aRows = aRows.filter(set => set.id === 331 || set.id === 669 || set.id === 585)

    // get attributes for each set
    baseName = 'attributes'
    const aAttributes = []
    for (const set of aRows) {
      const setId = set.id
      const attrs = await endpoints.get(`/v2.0/catalog/sets/${setId}/attributes`, {}, baseName)
      aAttributes.push(attrs.map(attr => { return { set_id: setId, ...attr } }))
    }
    endpoints.save(aAttributes, baseName)
  },
  exportProducts: async () => {
    // delete previous data
    const baseName = 'products'
    endpoints.delete(baseName)

    const aRows = await endpoints.get('/v2.0/catalog/product/', {}, baseName)

    endpoints.save(aRows, baseName)
  },
  testAddProduct: async () => {
    const product = {
      category_id: 4,
      ean: '1234567890123',
      name: 'Test Product asjdghasdghlkjagsh lkzsjfhlksajg',
      description: 'This is a test product ,kejhgfeywgfr wuet rowet rouetwy outruewo fryt',
      attributes: {
        "brand": 3755,
        "culoare_global": [
          54765
        ],
        "baby_tip_produs": 40415,
        "jucarii_tip_functionare": 40842,
        "material_multiselect_global": [
          36216
        ],
        "varsta_text_global": 12,
        "garantie_comerciala_global": 33738,
        "garantie_conformitate_global": 33757,
        "autonomie_h_global": "2h",
        "capacitate_acumulator_global": 5,
        "dimensiuni_l_x_a_x_i_cm_global": "20x60x20",
        "greutate_kg_global": 30,
        "greutate_suportata_global": 20,
        "tensiune_v_text_global": 220,
        "viteza_maxima": 20,
        "material_roti": [
          38306
        ],
        "baby_varsta_interval": [
          40041
        ]
      },
      images: {
        "0": "https://cdna.altex.ro/resize/media/catalog/product//l/e/71ce502ca67d3b8e424e73cceebfdd7e/lenovo-ideapad-110_1.jpg",
        "main": "https://cdna.altex.ro/resize/media/catalog/product//y/5/71ce502ca67d3b8e424e73cceebfdd7e/y520_1.jpg",
        "energy_class_image": "https://cdna.altex.ro/resize/media/catalog/product//y/5/71ce502ca67d3b8e424e73cceebfdd7e/y520_1.jpg"
      }
    }
  }
}


endpoints.exportCategories()
  .then(() => endpoints.exportAttributes())
  .then(() => endpoints.exportProducts())
  .then(() => console.log('Import finished'))
