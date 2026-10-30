// Cell widths by Unicode 11, as xterm's unicode11 addon has them: Claude's layout and ConPTY's cursor assume them.
// Each table lists ranges as base-36 pairs: the gap from the last range's end, then the range's length.
const COMBINING = 'lc,33,7o,6,7c,18,2,0,2,1,2,1,2,0,1l,5,b,a,2,0,1b,k,h,0,2u,7,2,5,3,1,2,3,y,0,2,0,v,q,2k,a,1n,8,a,0,p,3,2,8,2,2,2,4,18,2,3c,1b,1k,0,2,0,5,7,5,0,4,6,b,1,u,0,1n,0,5,3,9,0,l,1,r,0,3,1,1m,0,5,1,5,1,3,2,4,0,v,1,4,0,c,1,1m,0,5,4,2,1,5,0,l,1,n,5,2,0,1n,0,3,0,2,3,9,0,9,0,c,1,v,0,1q,0,d,0,1f,0,4,0,1m,2,6,2,2,3,8,1,c,1,u,0,1n,0,3,0,7,0,6,1,l,1,t,1,1m,1,5,3,9,0,l,1,2v,0,8,2,2,0,2j,0,3,6,d,7,2r,0,3,8,c,5,23,1,s,0,2,0,2,0,1k,d,2,4,2,1,6,a,2,z,a,0,2v,3,2,5,2,1,3,1,q,1,5,2,h,3,e,0,3,1,7,0,g,0,5f,4f,9q,2,qb,2,u,2,u,1,v,1,1t,1,2,6,9,0,3,a,a,0,1a,3,3b,1,z,0,3b,2,5,1,a,0,7,2,64,1,3,0,1n,0,2,6,2,0,2,0,3,7,7,9,3,0,1d,e,1u,3,1d,0,2,4,2,0,6,0,15,8,d,1,x,3,3,1,2,2,1l,0,2,1,4,0,2,2,1n,7,3,1,49,2,2,c,2,6,5,0,7,0,4,1,5j,1l,2,4,ek,4,r,4,1e,4,2,9,2p,w,2db,2,3y,0,2p,v,ff,3,30,1,n9x,3,2,9,x,1,29,1,7l,0,4,0,5,0,q,1,4e,1,r,h,e,0,13,7,q,a,1b,2,1d,0,3,3,3,1,14,0,1w,5,3,1,3,1,d,0,9,0,1c,0,1g,0,2,2,3,1,6,1,2,0,17,1,9,0,6n,0,3,0,5,0,fn5,0,ki,f,h,f,5s,0,6y,2,ea,0,6b,0,46,4,1af,2,2,1,6,3,15,2,5,0,4m,1,fy,3,f3,a,4x,0,1j,e,1l,2,1e,3,3,1,3,0,g,0,1f,2,11,4,2,7,1r,0,d,1,1h,8,b,3,2r,2,3,0,2,1,7,0,4h,0,4,7,m,1,1m,1,4,0,12,6,4,4,5g,7,3,2,2,0,o,0,2d,5,2,0,5,1,2,1,6n,3,7,1,2,1,s,1,2e,7,3,0,2,1,2z,0,2,0,3,5,2,0,2u,2,3,3,2,4,78,8,2,1,be,3,3,1,5,0,x,9,15,5,3,3,9,0,a,5,3,2,1b,c,2,1,bb,6,2,5,2,0,2b,l,3,6,2,1,2,1,3f,5,4,0,2,1,2,6,2,0,21,1,4,0,2,0,9o,1,470,8,at4,4,1o,6,t5,0,1s,3,f7v,1,2,3,43o,2,a,f,3,6,v,3,45,2,1j0,1i,5,1d,9,0,f,0,n,4,2,e,11t,6,2,g,3,6,2,1,2,4,7a,6,c6,3,15t,6,32,6,gzav,0,v,2n,3l,6n'
const WIDE = '3cw,2n,3i3,1,e,1,5b,3,4,0,3,0,ei,1,m,1,1f,b,18,0,k,0,e,0,9,1,i,1,6,1,9,0,6,0,m,0,8,1,2,0,5,0,3,0,8,0,5,1,t,0,10,0,2,0,5,2,2,0,1q,2,p,0,f,0,nw,1,1g,0,5,0,mj,p,2,2g,d,5x,r,b,5,15,5,g,3,2d,5,2s,6,16,2,2l,2,16,6,z,d,1a,2,13,9,5f3,1t,h3g,4,1i,wq,s,hw,8mb,6l9,e7,lt,9,n,y,2,i,2,3,46,2n,3k,6,m4a,3,t,4qf,9,ky,7bi,7y,1e,2,i,3,9,az,c21,0,5n,0,5b,0,3,9,2u,2,e,17,5,8,8,1,f,5,4b,w,d,8,2,1x,2,l,d,16,5,4,d,g,4,0,4,1y,2,0,2,56,3,1q,e,3,2,n,j,0,r,1,e,0,2f,2c,1d,1x,7,0,4,2,3,0,m,1,8,6,6e,b,82,2s,2,3,4,14,3,5,4,s,3,1e,35,3,5,2,6,2,e,5,12j,1ekd,3,1ekd'

const BMP = new Uint8Array(0x20000).fill(1) // planes 0 and 1
const FAR = [] // [from, to, width] past plane 1
BMP.fill(0, 0, 32)
BMP.fill(0, 0x7f, 0xa0)
for (const [ranges, width] of [[COMBINING, 0], [WIDE, 2]]) {
  const n = ranges.split(',').map(s => parseInt(s, 36))
  for (let i = 0, end = 0; i < n.length; i += 2) {
    const from = end + n[i]
    end = from + n[i + 1]
    if (end < BMP.length) BMP.fill(width, from, end + 1)
    else FAR.push(from, end, width)
  }
}

/** The cells code point `cp` takes: 0, 1 or 2. */
export function wcwidth(cp) {
  if (cp < 0x20000) return BMP[cp]
  for (let i = 0; i < FAR.length; i += 3) if (cp >= FAR[i] && cp <= FAR[i + 1]) return FAR[i + 2]
  return 1
}
