package com.devclaw.botcontrol.http;

import com.devclaw.botcontrol.adapters.local.PartnerLaunchConfig;
import java.util.concurrent.CountDownLatch;

/** Explicit opt-in Partner development main. One closed stdin document through
 * EOF; no environment, file, CLI credential or production transport fallback. */
public final class PartnerHttpMain {
    private PartnerHttpMain(){}
    public static void main(String[] args){
        try{
            if(args.length!=0)throw new IllegalArgumentException("PARTNER_ARGUMENTS");PartnerLaunchConfig config=PartnerLaunchConfig.read(System.in);LocalHttpServer server=LocalHttpServer.start(config);CountDownLatch stopped=new CountDownLatch(1);
            Runtime.getRuntime().addShutdownHook(new Thread(()->{try{server.close();}finally{stopped.countDown();}},"partner-http-stop"));
            System.out.println("{\"stage\":\"partner-ready\",\"port\":"+server.port()+"}");System.out.flush();stopped.await();
        }catch(Exception failure){System.out.println("{\"status\":\"failed\",\"reason\":\"PARTNER_STARTUP\"}");System.exit(1);}
    }
}
