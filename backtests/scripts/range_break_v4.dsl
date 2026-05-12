let kf          = KALMAN_OU(close, 60, 0.5)
let z           = (close - kf.x) / kf.sigma
let y           = Optimize.DailyEV.trades(10, 0.01, 5) default 0.1

signal.long.if  = cross_down(z, -y)
signal.short.if = cross_up(z, y)

exit.long.if    = cross_up(close,   kf.x)
exit.short.if   = cross_down(close, kf.x)

rules.positionMode = "close-previous"