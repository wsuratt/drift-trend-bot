import cron from 'node-cron';

import {
  Connection,
  Keypair 
} from '@solana/web3.js';

import {
  BN,
  DriftClient,
  Wallet,
  PerpMarketAccount,
  BASE_PRECISION,
  PositionDirection,
  MarketType,
  OrderType,
  PerpPosition,
  QUOTE_PRECISION
} from '@drift-labs/sdk';

import * as dotenv from 'dotenv';
dotenv.config();

type State = {
	marketPosition: Map<number, PerpPosition>;
};

interface MarketConfig {
  name: string;
  id: string;
  orderSize: BN;
}

const initOrderSize: number = 200; //usdc

const MARKETS: Record<number, MarketConfig> = {
  0: { name: 'SOL-PERP', id: '5426', orderSize: new BN(initOrderSize)},
  1: { name: 'BTC-PERP', id: '1', orderSize: new BN(initOrderSize)},
  2: { name: 'ETH-PERP', id: '1027', orderSize: new BN(initOrderSize)},
  4: { name: '1MBONK-PERP', id: '23095', orderSize: new BN(initOrderSize)},
  51: { name: 'SEI-PERP', id: '23149', orderSize: new BN(initOrderSize)},
  7: { name: 'DOGE-PERP', id: '74', orderSize: new BN(initOrderSize)},
  16: { name: 'LINK-PERP', id: '1975', orderSize: new BN(initOrderSize)},
  10: { name: '1MPEPE-PERP', id: '24478', orderSize: new BN(initOrderSize)},
  19: { name: 'TIA-PERP', id: '22861', orderSize: new BN(initOrderSize)},
  9: { name: 'SUI-PERP', id: '20947', orderSize: new BN(initOrderSize)},
  24: { name: 'JUP-PERP', id: '29210', orderSize: new BN(initOrderSize)},
  34: { name: 'POPCAT-PERP', id: '28782', orderSize: new BN(initOrderSize)},
  13: { name: 'XRP-PERP', id: '52', orderSize: new BN(initOrderSize)},
  59: { name: 'HYPE-PERP', id: '32196', orderSize: new BN(initOrderSize)},
};

class TrendBot {
  private driftClient: DriftClient;
  private agentState: State;
  private perpMarketIndices: Array<number>;

  constructor(
		clearingHouse: DriftClient
	) {
		this.driftClient = clearingHouse;
    this.perpMarketIndices = Object.keys(MARKETS).map(Number);
    this.agentState = {
			marketPosition: new Map<number, PerpPosition>()
		};
	}
  
  public async init() {
    await this.updateAgentState();

    try {
        for (const marketIndex of this.perpMarketIndices) {
          const perpMarketAccount = this.driftClient.getPerpMarketAccount(marketIndex);
      
          if (!perpMarketAccount) {
            console.log(`Market account not found for market index ${marketIndex}`);
            return null;
          }
          
          await this.updateOpenOrdersForMarket(perpMarketAccount);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
    } catch (error) {
      console.log(`Error in TrendBot: ${error}`);
    }
  }

  public async teardown() {
    console.log(`Tearing down TrendBot...`);

    if (this.driftClient.isSubscribed) {
      await this.driftClient.unsubscribe();
      console.log("DriftClient unsubscribed.");
    }

    console.log(`TrendBot successfully torn down.`);
  }

  private async updateAgentState(): Promise<void> {
		console.log('updating agent state')
		for (const marketIndex of this.perpMarketIndices) {
			const p = this.driftClient.getUser().getPerpPosition(marketIndex)
			if (p && !p.baseAssetAmount.isZero()) {
				this.agentState!.marketPosition.set(p.marketIndex, p);
			} else {
				this.agentState!.marketPosition.delete(marketIndex);
			}
		}
  }

  private async check20DayHigh(id: string, isHolding: boolean): Promise<boolean> {
    const response = await fetch(
      `https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/historical?id=${id}&count=20&interval=1d`,
      {
        method: 'GET',
        headers: {
          'X-CMC_PRO_API_KEY': process.env.CMC_PRO_API_KEY!,
          'Accept': '*/*',
        },
      }
    );
    const apiResponse = await response.json();
    console.log(apiResponse)
    const quotes = apiResponse.data.quotes;

    if (quotes.length < 20) {
      throw new Error("Not enough data to calculate a 20-day high.");
    }
  
    const prices = quotes.map((q: any) => q.quote.USD.price);
    const timestamps = quotes.map((q: any) => q.timestamp);
  
    const twentyDayHigh = Math.max(...prices);
  
    const recentPrice = prices[prices.length - 1];
    const recentTimestamp = timestamps[timestamps.length - 1];
  
    const isNew20DayHigh = recentPrice === twentyDayHigh;
  
    const lastFiveDaysPrices = prices.slice(-5);
    const within5Days = lastFiveDaysPrices.some((price: any) => price === twentyDayHigh);
  
    if (isNew20DayHigh && !isHolding) {
      console.log(
        `Buy Signal: Cryptocurrency ${apiResponse.data.name} is making a new 20-day high of ${twentyDayHigh} (as of ${recentTimestamp}).`
      );
      return true;
    }
  
    if (!within5Days && isHolding) {
      console.log(
        `Sell Signal: Cryptocurrency ${apiResponse.data.name} is past 5 days since its 20-day high of ${twentyDayHigh}.`
      );
      return false;
    }
  
    console.log(`Hold: No action needed for ${apiResponse.data.name}.`);
    return isHolding;
  }  

  private async updateOpenOrdersForMarket(marketAccount: PerpMarketAccount) {
    const marketIndex = marketAccount.marketIndex;

    const { currentLongExposure, currentShortExposure } = this.getCurrentExposure(marketIndex);
    const orderSizeInDollars = MARKETS[marketIndex].orderSize;
    const orderSize = this.getOrderSizeInAsset(marketIndex, orderSizeInDollars);
    console.log(orderSize.toNumber())

    const isHolding = currentLongExposure.gt(new BN(0));
    const isBuy = await this.check20DayHigh(MARKETS[marketIndex].id, isHolding);

    if (isBuy && !isHolding) {
      await this.placeNewOrder(marketIndex, false, orderSize);
    } else if (!isBuy && isHolding) {
      await this.placeNewOrder(marketIndex, true, currentLongExposure);
    }
  }

  private getOrderSizeInAsset(marketIndex: number, orderSizeInDollars: BN) {
    const oraclePriceData = this.driftClient.getOracleDataForPerpMarket(marketIndex);
    const price = oraclePriceData.price;
    const orderSizeInAsset = orderSizeInDollars.mul(QUOTE_PRECISION).mul(BASE_PRECISION).div(price);
    return orderSizeInAsset;
  }

  private getCurrentExposure(marketIndex: number): { currentLongExposure: BN, currentShortExposure: BN } {
    const currentPosition = this.agentState!.marketPosition.get(marketIndex);
    const currentLongExposure = currentPosition && currentPosition.baseAssetAmount.lt(new BN(0)) ? new BN(0) : currentPosition?.baseAssetAmount || new BN(0);
    const currentShortExposure = currentPosition && currentPosition.baseAssetAmount.gt(new BN(0)) ? new BN(0) : currentPosition?.baseAssetAmount.neg() || new BN(0);
    return { currentLongExposure, currentShortExposure };
  }

  private async placeNewOrder(
    marketIndex: number,
    isShort: boolean,
    orderSize: BN
  ) {
    try {
      this.driftClient.placePerpOrder({
        baseAssetAmount: orderSize,
        direction: isShort ? PositionDirection.SHORT : PositionDirection.LONG,
        marketIndex: marketIndex,
        marketType: MarketType.PERP,
        orderType: OrderType.MARKET
      });
    } catch (e) {
      console.error('Error creating order: ', e);
      return;
    }
  }
}

(async () => {
  try {
    console.log(`Running TrendBot tasks at 12 AM UTC...`);
    const connection = new Connection(process.env.ENDPOINT!.toString());
    const privateKey = process.env.KEEPER_PRIVATE_KEY!;

    const loadedKey = Uint8Array.from(
      privateKey.split(',').map((val) => Number(val))
    );
    const keypair = Keypair.fromSecretKey(loadedKey);
    const wallet = new Wallet(keypair);

    const driftClient = new DriftClient({
      connection,
      wallet,
      env: 'mainnet-beta',
    });

    while (!(await driftClient.subscribe())) {
      console.log('retrying driftClient.subscribe in 1s...');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const trendBot = new TrendBot(driftClient);
    await trendBot.init();
    await trendBot.teardown()
  } catch (error) {
    console.error(`Error running TrendBot tasks:`, error);
  }
})();
