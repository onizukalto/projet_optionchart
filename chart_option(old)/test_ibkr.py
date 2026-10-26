from ib_async import IB, Future

ib = IB()
ib.connect("127.0.0.1", 7497, clientId=1)  # 7497 = paper, 7496 = réel
print("Connecté :", ib.isConnected())

contrat = Future("MNQ", lastTradeDateOrContractMonth="202612", exchange="CME")
ib.qualifyContracts(contrat)
print("Contrat :", contrat.localSymbol)

# Demander le temps réel ; IBKR bascule sur le différé si tu n'as pas l'abonnement
ib.reqMarketDataType(1)
ticker = ib.reqMktData(contrat)
ib.sleep(5)  # laisser le temps aux données d'arriver

types = {1: "✅ TEMPS RÉEL", 2: "Figé", 3: "⏱️ DIFFÉRÉ (~10-15 min)", 4: "Différé figé"}
print("Type de données :", types.get(ticker.marketDataType, "inconnu"))
print("Dernier prix :", ticker.last, "| Bid :", ticker.bid, "| Ask :", ticker.ask)

ib.disconnect()