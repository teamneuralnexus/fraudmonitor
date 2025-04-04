export default defineEventHandler(async (event) => {
    if (!event.context.user) {
      throw createError({
        message: "Unauthorised Access not allowed",
        statusCode: 401
      })
    }
  
    const userId = event.context.user.id
    const body = await readBody(event)
  
    if (!Array.isArray(body)) {
      throw createError({
        message: "Request body must be an array of transactions",
        statusCode: 400
      })
    }
  
    for (const transaction of body) {
      if (!transaction.transaction_id) {
        throw createError({
          message: "All transactions must have a transaction_id",
          statusCode: 400
        })
      }
    }
  
    try {
      const results = {}
      const MAX_CONCURRENCY = 5
      const chunks = []
  
      for (let i = 0; i < body.length; i += MAX_CONCURRENCY) {
        chunks.push(body.slice(i, i + MAX_CONCURRENCY))
      }
  
      for (const chunk of chunks) {
        await Promise.all(chunk.map(async (transaction) => {
          const transactionData = {
            transaction_id: transaction.transaction_id,
            transaction_date: transaction.transaction_date,
            transaction_amount: transaction.transaction_amount,
            transaction_channel: transaction.transaction_channel,
            transaction_payment_mode: transaction.transaction_payment_mode,
            payment_gateway_bank: transaction.payment_gateway_bank,
            payer_email: transaction.payer_email,
            payer_mobile: transaction.payer_mobile,
            payer_card_brand: transaction.payer_card_brand,
            payer_device: transaction.payer_device,
            payer_browser: transaction.payer_browser,
            payee_id: transaction.payee_id
          }
  
          let fraudResult
  
          if (transaction.custom_rules && transaction.custom_rules.length > 0) {
            for (const rule of transaction.custom_rules) {
              const value = transactionData[rule.field]
              let isRuleViolated = false
  
              switch (rule.condition) {
                case 'equals':
                  isRuleViolated = value === rule.value
                  break
                case 'contains':
                  isRuleViolated = value?.includes(rule.value)
                  break
                case 'greater_than':
                  isRuleViolated = parseFloat(value) > parseFloat(rule.value)
                  break
                case 'less_than':
                  isRuleViolated = parseFloat(value) < parseFloat(rule.value)
                  break
                case 'starts_with':
                  isRuleViolated = value?.startsWith(rule.value)
                  break
                case 'ends_with':
                  isRuleViolated = value?.endsWith(rule.value)
                  break
              }
  
              if (isRuleViolated) {
                fraudResult = {
                  is_fraud_detected: true,
                  fraud_source: 'rule',
                  fraud_reason: `Rule violation: ${rule.field} ${rule.condition} ${rule.value}`,
                  fraud_score: 1
                }
                break
              }
            }
          }
  
          if (!fraudResult) {
            fraudResult = await detectFraudPatterns(transactionData, transaction.custom_rules || [])
          }
  
          results[transaction.transaction_id] = {
            is_fraud: fraudResult.is_fraud_detected,
            fraud_source: fraudResult.fraud_source,
            fraud_reason: fraudResult.fraud_reason,
            fraud_score: fraudResult.fraud_score,
            custom_rules: transaction.custom_rules
          }
  
          try {
            const insertQuery = `
              INSERT INTO fraud_detection (
                transaction_id, transaction_date, transaction_amount, 
                transaction_channel, transaction_payment_mode, payment_gateway_bank,
                payer_email, payer_mobile, payer_card_brand, payer_device, 
                payer_browser, payee_id, is_fraud_predicted, fraud_source, 
                fraud_reason, fraud_score, user_id
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
            `
            const insertValues = [
              transaction.transaction_id,
              transaction.transaction_date,
              transaction.transaction_amount,
              transaction.transaction_channel,
              transaction.transaction_payment_mode,
              transaction.payment_gateway_bank,
              transaction.payer_email,
              transaction.payer_mobile,
              transaction.payer_card_brand,
              transaction.payer_device,
              transaction.payer_browser,
              transaction.payee_id,
              fraudResult.is_fraud_detected,
              fraudResult.fraud_source,
              fraudResult.fraud_reason,
              fraudResult.fraud_score,
              userId
            ]
            await pool.query(insertQuery, insertValues)
          } catch (error) {
            console.error(`Database error for transaction ${transaction.transaction_id}:`, error)
          }
        }))
      }
  
      return results
    } catch (error) {
      console.error('Server error:', error)
      throw createError({
        message: "Internal server error",
        statusCode: 500
      })
    }
  })