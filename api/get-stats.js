// --- Funciones auxiliares copiadas de tu background.js ---
// (Estas se ejecutan en el servidor, no en la extensión)

function formatPrice(amount, currencyCode) {
    try {
        const locale = currencyCode === 'ARS' ? 'es-AR' : 'en-US';
        return new Intl.NumberFormat(locale, {
            style: 'currency',
            currency: currencyCode,
            maximumFractionDigits: 2
        }).format(amount);
    } catch (e) {
        return `${currencyCode} ${amount}`;
    }
}

function formatDate(timestamp, specific = false) {
    if (!timestamp) return "Fecha desc.";
    try {
        const dateObj = typeof timestamp === 'number' ? new Date(timestamp * 1000) : new Date(timestamp);
        if (specific) {
            return dateObj.toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: 'numeric' });
        }
        return dateObj.toLocaleDateString('es-AR', { month: 'short', year: 'numeric' });
    } catch (e) {
        console.error("BG Gatillo: Error formateando fecha", e);
        return "Fecha desc.";
    }
}

// --- Esta es la función principal del servidor (Handler) ---

export default async function handler(request, response) {
    
    // --- 1. CONFIGURACIÓN DE SEGURIDAD (CORS) ---
    // Esto asegura que SOLO Steam pueda llamar a tu API.
    response.setHeader('Access-Control-Allow-Origin', 'https://store.steampowered.com');
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Maneja la petición "OPTIONS" que envía el navegador antes del GET
    if (request.method === 'OPTIONS') {
        return response.status(200).end();
    }

    // --- 2. OBTENER LA API KEY SECRETA ---
    // Usamos la variable de entorno de Vercel (¡Nunca se ve en el código!)
    const TU_API_KEY = process.env.ITAD_API_KEY;
    if (!TU_API_KEY) {
        console.error("Error: ITAD_API_KEY no está configurada en Vercel.");
        return response.status(500).json({ status: "API_ERROR", message: "Error interno del servidor." });
    }

    // --- 3. OBTENER DATOS DEL CLIENTE (Extensión) ---
    const { shopID } = request.query;
    if (!shopID) {
        return response.status(400).json({ status: "API_ERROR", message: "Falta el parámetro shopID." });
    }

    // Constantes
    const STEAM_SHOP_ID = 61;
    const REGION = "AR";

    // --- 4. LÓGICA DE FETCH (Copiada de tu background.js) ---
    // (Esta parte es idéntica a tu código original)
    let gid = null;
    let resultData = {
        historicalLow: null,
        historicalHigh: null,
        lastSale: null,
        chartData: { labels: [], prices: [], currency: "USD" }
    };

    try {
        // --- PASO 1: Obtener GID ---
        const gidResponse = await fetch(`https://api.isthereanydeal.com/lookup/id/shop/${STEAM_SHOP_ID}/v1?key=${TU_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify([shopID])
        });
        if (!gidResponse.ok) throw new Error(`GID Status ${gidResponse.status}`);
        const gidData = await gidResponse.json();
        gid = gidData[shopID];
        if (!gid) {
            console.warn(`Proxy Gatillo: No GID for ${shopID}`);
            // Devolvemos 200 (OK) pero con un status interno
            return response.status(200).json({ status: "NO_HISTORY", message: "Juego no encontrado." });
        }

        // --- PASO 2: Obtener Mínimo Histórico ---
        let historicalCurrency = "USD";
        try {
            const lowResponse = await fetch(`https://api.isthereanydeal.com/games/historylow/v1?key=${TU_API_KEY}&country=${REGION}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify([gid])
            });
            if (!lowResponse.ok) throw new Error(`AR Low Status ${lowResponse.status}`);
            const lowData = await lowResponse.json();
            if (lowData && lowData.length > 0 && lowData[0].low && lowData[0].low.price) {
                const lowInfo = lowData[0].low;
                historicalCurrency = lowInfo.price.currency || "USD";
                resultData.historicalLow = {
                    price: formatPrice(lowInfo.price.amount, historicalCurrency),
                    date: formatDate(lowInfo.timestamp),
                    amount: lowInfo.price.amount, // <-- Añadido para el gráfico
                    timestamp: lowInfo.timestamp * 1000 // <-- Añadido para el gráfico
                };
            } else {
                throw new Error("AR Low vacía");
            }
        } catch (lowError) {
            console.warn("Proxy Gatillo: Falló AR Low, intentando global:", lowError.message);
            // (Aquí podrías añadir un fallback global si quisieras)
        }
        resultData.chartData.currency = historicalCurrency;

        // --- PASO 3: Obtener Historial Completo ---
        try {
            const historyResponse = await fetch(`https://api.isthereanydeal.com/games/history/v2?key=${TU_API_KEY}&id=${gid}&country=${REGION}&shops=${STEAM_SHOP_ID}`);
            if (!historyResponse.ok) throw new Error(`History Status ${historyResponse.status}`);
            const historyData = await historyResponse.json();

            if (historyData && Array.isArray(historyData) && historyData.length > 0) {
                let maxPrice = 0; let maxPriceDate = null;
                let lastSaleDate = null; let lastSaleCut = 0;
                const sortedHistory = historyData.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
                
                sortedHistory.forEach(entry => {
                    if (entry.timestamp && entry.deal) {
                        const price = entry.deal.price.amount;
                        const regular = entry.deal.regular.amount;
                        const cut = entry.deal.cut;
                        const date = entry.timestamp;

                        resultData.chartData.labels.push(new Date(date).getTime());
                        resultData.chartData.prices.push(price);

                        if (regular > maxPrice) { maxPrice = regular; maxPriceDate = date; }
                        if (cut > 0) { lastSaleDate = date; lastSaleCut = cut; }
                    }
                });

                if (maxPrice > 0) {
                    resultData.historicalHigh = {
                        price: formatPrice(maxPrice, historicalCurrency),
                        date: formatDate(maxPriceDate),
                        amount: maxPrice
                    };
                }
                if (lastSaleDate) {
                    resultData.lastSale = { date: formatDate(lastSaleDate, true), cut: Math.round(lastSaleCut) };
                }
            }
        } catch (historyError) {
            console.error("Proxy Gatillo: Error al obtener historial completo:", historyError.message);
        }

        // --- PASO 5: Devolver el objeto de métricas completo ---
        // ¡Éxito! Devolvemos los datos a la extensión
        return response.status(200).json(resultData);

    } catch (error) {
        console.error("Error fatal en fetchHistoricalStats (Vercel):", error.message);
        if (error.message.includes("No GID") || error.message.includes("AR Low vacía")) {
            return response.status(200).json({ status: "NO_HISTORY", message: "No se encontró historial de precios." });
        }
        return response.status(500).json({ status: "API_ERROR", message: `Error del proxy: ${error.message}` });
    }
}