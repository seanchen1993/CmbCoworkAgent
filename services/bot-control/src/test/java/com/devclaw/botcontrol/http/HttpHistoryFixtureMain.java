package com.devclaw.botcontrol.http;

import com.devclaw.botcontrol.adapters.local.LocalLaunchConfig;
import com.devclaw.botcontrol.persistence.DatabaseReadiness;
import com.zaxxer.hikari.HikariDataSource;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.*;
import java.util.*;

/** Fixed committed checksum fixture in an owned disposable DB, test main only. */
public final class HttpHistoryFixtureMain {
    private static byte[] line(int maximum) throws Exception {
        ByteArrayOutputStream out=new ByteArrayOutputStream();long end=System.nanoTime()+30000000000L;
        while(System.nanoTime()<end){if(System.in.available()==0){Thread.sleep(5);continue;}int b=System.in.read();if(b<0)throw new IllegalStateException("TEST_CONTROL");if(b=='\n')return out.toByteArray();if(out.size()==maximum)throw new IllegalStateException("TEST_CONTROL");out.write(b);}throw new IllegalStateException("TEST_CONTROL");
    }
    private static final class Snapshot {
        final Object[] values=new Object[10]; final byte[][] bytes=new byte[10][]; String hash;
        final byte[][] v2=new byte[10][];
        final byte[][] v3=new byte[10][];
        final byte[][] v4=new byte[10][];
        final byte[][] v5=new byte[10][];
    }
    private static Snapshot snapshot(Connection c) throws Exception {
        Snapshot s=new Snapshot();ByteArrayOutputStream bytes=new ByteArrayOutputStream();DataOutputStream data=new DataOutputStream(bytes);
        String[] names={"installed_rank","version","description","type","script","checksum","installed_by","installed_on","execution_time","success"};
        try(PreparedStatement p=c.prepareStatement("SELECT * FROM bot_schema_history ORDER BY installed_rank")){p.setQueryTimeout(2);try(ResultSet r=p.executeQuery()){
            ResultSetMetaData m=r.getMetaData();if(m.getColumnCount()!=10||!r.next())throw new IllegalStateException("TEST_HISTORY");
            for(int i=0;i<10;i++){if(!names[i].equals(m.getColumnName(i+1)))throw new IllegalStateException("TEST_HISTORY");data.writeUTF(names[i]);data.writeInt(m.getColumnType(i+1));s.values[i]=r.getObject(i+1);s.bytes[i]=r.getBytes(i+1);data.writeInt(s.bytes[i]==null?-1:s.bytes[i].length);if(s.bytes[i]!=null)data.write(s.bytes[i]);}
            if(!Integer.valueOf(1).equals(s.values[0])||!"1".equals(s.values[1])||!(s.values[5] instanceof Integer)||!Boolean.TRUE.equals(s.values[9]))throw new IllegalStateException("TEST_HISTORY");
            if(!r.next()||r.getInt(1)!=2||!"2".equals(r.getString(2))||!(r.getObject(6) instanceof Integer)||!Boolean.TRUE.equals(r.getObject(10)))throw new IllegalStateException("TEST_HISTORY");
            for(int i=0;i<10;i++){s.v2[i]=r.getBytes(i+1);data.writeInt(s.v2[i]==null?-1:s.v2[i].length);if(s.v2[i]!=null)data.write(s.v2[i]);}
            if(!r.next()||r.getInt(1)!=3||!"3".equals(r.getString(2))||!(r.getObject(6) instanceof Integer)||!Boolean.TRUE.equals(r.getObject(10)))throw new IllegalStateException("TEST_HISTORY");
            for(int i=0;i<10;i++){s.v3[i]=r.getBytes(i+1);data.writeInt(s.v3[i]==null?-1:s.v3[i].length);if(s.v3[i]!=null)data.write(s.v3[i]);}
            if(!r.next()||r.getInt(1)!=4||!"4".equals(r.getString(2))||!(r.getObject(6) instanceof Integer)||!Boolean.TRUE.equals(r.getObject(10)))throw new IllegalStateException("TEST_HISTORY");
            for(int i=0;i<10;i++){s.v4[i]=r.getBytes(i+1);data.writeInt(s.v4[i]==null?-1:s.v4[i].length);if(s.v4[i]!=null)data.write(s.v4[i]);}
            if(!r.next()||r.getInt(1)!=5||!"5".equals(r.getString(2))||!(r.getObject(6) instanceof Integer)||!Boolean.TRUE.equals(r.getObject(10)))throw new IllegalStateException("TEST_HISTORY");
            for(int i=0;i<10;i++){s.v5[i]=r.getBytes(i+1);data.writeInt(s.v5[i]==null?-1:s.v5[i].length);if(s.v5[i]!=null)data.write(s.v5[i]);}
            if(r.next())throw new IllegalStateException("TEST_HISTORY");
        }}
        byte[] digest=MessageDigest.getInstance("SHA-256").digest(bytes.toByteArray());StringBuilder hex=new StringBuilder();for(byte b:digest)hex.append(String.format(Locale.ROOT,"%02x",b&255));s.hash=hex.toString();return s;
    }
    private static void replaceChecksum(Connection c,int expected,int replacement) throws Exception {
        c.setAutoCommit(false);try(PreparedStatement p=c.prepareStatement("UPDATE bot_schema_history SET checksum=? WHERE installed_rank=1 AND version='1' AND checksum=? AND success=1")){p.setInt(1,replacement);p.setInt(2,expected);p.setQueryTimeout(2);if(p.executeUpdate()!=1){c.rollback();throw new IllegalStateException("TEST_HISTORY");}c.commit();}finally{c.setAutoCommit(true);}
    }
    public static void main(String[] args){
        try{
            if(args.length!=0)throw new IllegalStateException("TEST_SELECTION");LocalLaunchConfig config=LocalLaunchConfig.parse(line(LocalLaunchConfig.MAX_BYTES));
            try(HikariDataSource source=config.database.openPool();Connection c=source.getConnection()){
                DatabaseReadiness.requireReady(source);Snapshot original=snapshot(c);int checksum=(Integer)original.values[5],changed=checksum+1;
                replaceChecksum(c,checksum,changed);Snapshot mutated=snapshot(c);
                for(int i=0;i<10;i++)if(i!=5&&!Arrays.equals(original.bytes[i],mutated.bytes[i]))throw new IllegalStateException("TEST_HISTORY");
                if(!Arrays.deepEquals(original.v2,mutated.v2))throw new IllegalStateException("TEST_HISTORY");
                if(!Arrays.deepEquals(original.v3,mutated.v3))throw new IllegalStateException("TEST_HISTORY");
                if(!Arrays.deepEquals(original.v4,mutated.v4))throw new IllegalStateException("TEST_HISTORY");
                if(!Arrays.deepEquals(original.v5,mutated.v5))throw new IllegalStateException("TEST_HISTORY");
                if(((Integer)mutated.values[5])!=changed)throw new IllegalStateException("TEST_HISTORY");
                System.out.println("{\"stage\":\"history-mutated\",\"originalFacts\":\""+original.hash+"\",\"mutatedFacts\":\""+mutated.hash+"\",\"rows\":5,\"columns\":10}");System.out.flush();
                if(!"restore".equals(new String(line(32),StandardCharsets.US_ASCII)))throw new IllegalStateException("TEST_CONTROL");
                // Runtime refusal must not repair/change ANY mutated fact. Never
                // restore unexpectedly changed/extra/missing rows by assumption.
                if(!mutated.hash.equals(snapshot(c).hash))throw new IllegalStateException("TEST_HISTORY_CHANGED");
                replaceChecksum(c,changed,checksum);if(!original.hash.equals(snapshot(c).hash))throw new IllegalStateException("TEST_HISTORY_RESTORE");DatabaseReadiness.requireReady(source);
                System.out.println("{\"stage\":\"history-restored\",\"originalFacts\":\""+original.hash+"\",\"mutatedFactsUnchangedByRuntime\":true,\"completeOriginalFactsRestored\":true}");System.out.flush();
            }
        }catch(Exception failure){System.out.println("{\"status\":\"failed\",\"category\":\"C2_HISTORY_FIXTURE\"}");System.exit(1);}
    }
}
